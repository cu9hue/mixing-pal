use crate::osc::query::LiveQuery;
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// Deliberately equal to `device_chains::QUERY_TIMEOUT` and for the same
/// reason: the poll loop calls `RequestTable::expire` on that window every
/// tick and expiry drops the waiter, so a longer timeout here could never
/// be reached -- it would only make this constant a lie.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Clip {
    /// The clip slot's own index, NOT this clip's position in the list.
    /// `get_clip_notes(track, clip)` takes exactly this number, and a set
    /// with a gap in its slots is the normal case, not the exception.
    pub slot: i32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackClips {
    pub track: i32,
    /// `None` means the flag did not arrive, and the track is named in
    /// `ClipMap::midi_missing` as well. NOT defaulted to `false`: that reads
    /// as "this is an audio track, there are no notes to read", which is a
    /// fabricated answer where the truth is a gap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midi: Option<bool>,
    /// Filled slots only. Empty means the track really has no clips -- never
    /// "we could not read it", which is what `ClipMap::missing` says instead.
    pub clips: Vec<Clip>,
    pub total_slots: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_slot: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipMap {
    pub tracks: Vec<TrackClips>,
    /// Track indices that did not answer, or answered something this decoder
    /// refused. Named rather than dropped: a silently short list reads as
    /// "those tracks have no clips".
    pub missing: Vec<i32>,
    /// Tracks whose clips arrived but whose MIDI flag did not.
    pub midi_missing: Vec<i32>,
}

/// `/live/track/get/clips/name` replies `(track_index, *slots)`, one entry
/// per clip slot, `Nil` for an empty one -- `track.py`'s
/// `track_get_clip_names` returns `None` there and pythonosc encodes that
/// with the OSC `N` type tag.
///
/// Fails closed on any other type: guessing which entries are clips would
/// invent a session grid, and an invented grid sends `get_clip_notes` to a
/// slot that holds nothing.
fn decode_clips(reply: &[OscType]) -> Option<TrackClips> {
    let track = match reply.first()? {
        OscType::Int(i) => *i,
        _ => return None,
    };
    let mut clips = Vec::new();
    for (slot, arg) in reply.get(1..)?.iter().enumerate() {
        match arg {
            OscType::Nil => {}
            OscType::String(s) => clips.push(Clip {
                slot: slot as i32,
                name: fence(s),
            }),
            _ => return None,
        }
    }
    Some(TrackClips {
        track,
        midi: None,
        total_slots: reply.len() - 1,
        next_slot: None,
        clips,
    })
}

/// `/live/track/get/has_midi_input` replies `(track_index, flag)`.
///
/// Accepts both encodings of the flag, for the same reason
/// `device_chains::decode_flags` does.
fn decode_midi_flag(reply: &[OscType]) -> Option<bool> {
    match reply.get(1)? {
        OscType::Bool(b) => Some(*b),
        OscType::Int(i) => Some(*i != 0),
        _ => None,
    }
}

const SESSION_PAGE: &str = "/live/mixingpal/get/session/clips";
const PAGE_SIZE: i32 = 16;
const MAX_PAGES: usize = 64;

async fn read_track(
    q: &LiveQuery,
    track: i32,
    start_slot: i32,
    timeout: Duration,
) -> (Option<TrackClips>, bool) {
    let mut entry: Option<TrackClips> = None;
    let mut start = start_slot;
    for _ in 0..MAX_PAGES {
        let reply = q
            .query(
                SESSION_PAGE,
                vec![
                    OscType::Int(track),
                    OscType::Int(start),
                    OscType::Int(PAGE_SIZE),
                ],
                timeout,
            )
            .await;
        let page = reply.ok().and_then(|reply| {
            let [OscType::Int(actual_track), OscType::Int(actual_start), OscType::Int(total), body @ ..] = reply.as_slice() else { return None; };
            if *actual_track != track || *actual_start != start || *total < 0 || body.len() != (*total - start).clamp(0, PAGE_SIZE) as usize { return None; }
            let mut args = vec![OscType::Int(track)];
            args.extend_from_slice(body);
            let mut page = decode_clips(&args)?;
            for clip in &mut page.clips { clip.slot += start; }
            page.total_slots = *total as usize;
            Some((page, body.len() as i32))
        });
        let Some((page, count)) = page else {
            if let Some(entry) = &mut entry {
                entry.next_slot = Some(start);
            }
            return (entry, true);
        };
        if entry
            .as_ref()
            .is_some_and(|entry| entry.total_slots != page.total_slots)
        {
            return (None, true);
        }
        let combined = entry.get_or_insert(TrackClips {
            track,
            midi: None,
            clips: Vec::new(),
            total_slots: page.total_slots,
            next_slot: None,
        });
        combined.clips.extend(page.clips);
        start += count;
        if start as usize >= combined.total_slots {
            combined.next_slot = None;
            return (entry, false);
        }
        combined.next_slot = Some(start);
    }
    (entry, false)
}

#[cfg(test)]
pub async fn get_clips(q: Arc<LiveQuery>, num_tracks: i32, timeout: Duration) -> ClipMap {
    get_clips_range(q, 0, num_tracks, 0, timeout).await
}

pub async fn get_clips_range(
    q: Arc<LiveQuery>,
    first_track: i32,
    num_tracks: i32,
    start_slot: i32,
    timeout: Duration,
) -> ClipMap {
    let handles: Vec<_> = (first_track..first_track.saturating_add(num_tracks))
        .map(|track| {
            let q = q.clone();
            tokio::spawn(async move {
                let (page, flag) = tokio::join!(
                    read_track(&q, track, start_slot, timeout),
                    q.query(
                        "/live/track/get/has_midi_input",
                        vec![OscType::Int(track)],
                        timeout
                    ),
                );
                (page, flag.ok().as_deref().and_then(decode_midi_flag))
            })
        })
        .collect();
    let mut tracks = Vec::new();
    let mut missing = Vec::new();
    let mut midi_missing = Vec::new();
    for (offset, handle) in handles.into_iter().enumerate() {
        let track = first_track + offset as i32;
        match handle.await {
            Ok(((Some(mut entry), failed), midi)) => {
                entry.midi = midi;
                if midi.is_none() {
                    midi_missing.push(track);
                }
                if failed {
                    missing.push(track);
                }
                tracks.push(entry);
            }
            _ => missing.push(track),
        }
    }
    ClipMap {
        tracks,
        missing,
        midi_missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::sync::Mutex;

    #[test]
    fn decode_clips_keeps_the_real_slot_index_of_every_filled_slot() {
        // Slot 1 is empty. If the decoder renumbered, `get_clip_notes`
        // would be sent to slot 1 for the clip that lives in slot 2.
        let reply = vec![
            OscType::Int(3),
            OscType::String("Verse Chords".into()),
            OscType::Nil,
            OscType::String("Fill".into()),
        ];
        let t = decode_clips(&reply).unwrap();
        assert_eq!(t.track, 3);
        assert_eq!(
            t.clips,
            vec![
                Clip {
                    slot: 0,
                    name: "«Verse Chords»".into()
                },
                Clip {
                    slot: 2,
                    name: "«Fill»".into()
                },
            ]
        );
    }

    #[test]
    fn an_unnamed_clip_is_a_clip_and_an_empty_slot_is_not() {
        // Producers leave clips unnamed constantly. Live sends "" for those
        // and Nil for an empty slot, so the two must not collapse.
        let reply = vec![OscType::Int(0), OscType::String("".into()), OscType::Nil];
        let t = decode_clips(&reply).unwrap();
        assert_eq!(t.clips.len(), 1);
        assert_eq!(t.clips[0].slot, 0);
    }

    #[test]
    fn decode_clips_fails_closed_on_an_unexpected_type() {
        // Guessing which entries are clips would invent a session grid.
        let reply = vec![
            OscType::Int(0),
            OscType::String("A".into()),
            OscType::Int(9),
        ];
        assert!(decode_clips(&reply).is_none());
    }

    #[test]
    fn a_track_with_no_clips_decodes_to_an_empty_list_not_none() {
        let t = decode_clips(&[OscType::Int(4)]).unwrap();
        assert_eq!(t.track, 4);
        assert!(t.clips.is_empty());
    }

    #[test]
    fn the_midi_flag_is_read_from_either_encoding() {
        // pythonosc serialises a Python bool with the T/F type tags; an int
        // is just as unambiguous. Accepting only one would lose the flag on
        // a detail no test outside Live can settle.
        assert_eq!(
            decode_midi_flag(&[OscType::Int(0), OscType::Bool(true)]),
            Some(true)
        );
        assert_eq!(
            decode_midi_flag(&[OscType::Int(0), OscType::Int(0)]),
            Some(false)
        );
        assert_eq!(
            decode_midi_flag(&[OscType::Int(0), OscType::String("y".into())]),
            None
        );
    }

    /// `clips[i]` is track i's slots (`None` for an empty slot), `midi[i]`
    /// its MIDI flag. `silent` names tracks that get no clip reply, and
    /// `silent_midi` the same for the flag reply -- which is what a lost
    /// reply looks like from the client's side.
    ///
    /// `hold_until_all_arrive` makes the fake buffer every request on either
    /// address and answer none until it has seen that many combined. A
    /// serial implementation can never satisfy it, so it is how the test
    /// asserts the requests really do go out concurrently.
    #[derive(Default)]
    struct FakeLive {
        clips: Vec<Vec<Option<String>>>,
        midi: Vec<bool>,
        silent: Vec<i32>,
        silent_midi: Vec<i32>,
        hold_until_all_arrive: Option<usize>,
        paged_only: bool,
        silent_page: Option<usize>,
        malformed_page: Option<usize>,
        changed_total_page: Option<usize>,
    }

    async fn fake_live(fake: FakeLive) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let mut held_clips: Vec<i32> = Vec::new();
            let mut held_pages: Vec<Vec<OscType>> = Vec::new();
            let mut held_midi: Vec<i32> = Vec::new();
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let track = match req.args.first() {
                    Some(OscType::Int(i)) => *i,
                    _ => continue,
                };
                match req.addr.as_str() {
                    "/live/track/get/clips/name" if !fake.paged_only => {
                        if fake.silent.contains(&track) {
                            continue; // the reply Live could not send
                        }
                        held_clips.push(track);
                    }
                    "/live/mixingpal/get/session/clips" => {
                        if fake.silent.contains(&track) {
                            continue;
                        }
                        let start = match req.args.get(1) {
                            Some(OscType::Int(v)) => *v as usize,
                            _ => continue,
                        };
                        if fake.silent_page == Some(start) {
                            continue;
                        }
                        let limit = match req.args.get(2) {
                            Some(OscType::Int(v)) => *v as usize,
                            _ => continue,
                        };
                        let slots = fake.clips.get(track as usize).cloned().unwrap_or_default();
                        let mut reply = vec![
                            OscType::Int(track),
                            OscType::Int(start as i32),
                            OscType::Int(slots.len() as i32),
                        ];
                        reply.extend(slots.iter().skip(start).take(limit).map(|s| {
                            s.as_ref()
                                .map(|s| OscType::String(s.clone()))
                                .unwrap_or(OscType::Nil)
                        }));
                        if fake.malformed_page == Some(start) {
                            reply.pop();
                        }
                        if fake.changed_total_page == Some(start) {
                            reply[2] = OscType::Int(slots.len() as i32 + 1);
                        }
                        held_pages.push(reply);
                    }
                    "/live/track/get/has_midi_input" => {
                        if fake.silent_midi.contains(&track) {
                            continue;
                        }
                        held_midi.push(track);
                    }
                    _ => continue,
                }
                if let Some(expect) = fake.hold_until_all_arrive {
                    if held_clips.len() + held_pages.len() + held_midi.len() < expect {
                        continue; // answer nothing until every request is in
                    }
                }
                for reply in held_pages.drain(..) {
                    let _ = live
                        .send_to(app_port, "/live/mixingpal/get/session/clips", reply)
                        .await;
                }
                for t in held_clips.drain(..) {
                    let mut reply = vec![OscType::Int(t)];
                    if let Some(slots) = fake.clips.get(t as usize) {
                        for slot in slots {
                            reply.push(match slot {
                                Some(name) => OscType::String(name.clone()),
                                None => OscType::Nil,
                            });
                        }
                    }
                    let _ = live
                        .send_to(app_port, "/live/track/get/clips/name", reply)
                        .await;
                }
                for t in held_midi.drain(..) {
                    let flag = fake.midi.get(t as usize).copied().unwrap_or(true);
                    let _ = live
                        .send_to(
                            app_port,
                            "/live/track/get/has_midi_input",
                            vec![OscType::Int(t), OscType::Bool(flag)],
                        )
                        .await;
                }
            }
        });

        Arc::new(LiveQuery::new(app, table))
    }

    fn slots(names: &[Option<&str>]) -> Vec<Option<String>> {
        names.iter().map(|n| n.map(String::from)).collect()
    }

    #[tokio::test]
    async fn large_session_tracks_are_read_in_pages_without_losing_slot_indices() {
        let mut clips = vec![Some("long clip name".repeat(9)); 300];
        clips[17] = None;
        clips[299] = Some("".into());
        let q = fake_live(FakeLive {
            clips: vec![clips],
            midi: vec![false],
            paged_only: true,
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 1, Duration::from_millis(100)).await;
        assert!(map.missing.is_empty());
        assert_eq!(map.tracks[0].midi, Some(false));
        assert_eq!(map.tracks[0].clips.len(), 299);
        assert_eq!(map.tracks[0].clips.last().unwrap().slot, 299);
    }

    #[tokio::test]
    async fn bounded_session_reads_expose_a_slot_that_recovers_the_tail() {
        let q = fake_live(FakeLive {
            clips: vec![vec![], vec![Some("clip".into()); 1050]],
            midi: vec![false, true],
            paged_only: true,
            ..Default::default()
        })
        .await;
        let first = get_clips_range(q.clone(), 1, 1, 0, QUERY_TIMEOUT).await;
        let track = &first.tracks[0];
        assert_eq!(track.track, 1);
        assert_eq!(track.total_slots, 1050);
        assert_eq!(track.clips.len(), 1024);
        assert_eq!(track.next_slot, Some(1024));
        let tail = get_clips_range(q, 1, 1, track.next_slot.unwrap(), QUERY_TIMEOUT).await;
        assert_eq!(tail.tracks[0].clips.len(), 26);
        assert_eq!(tail.tracks[0].clips[0].slot, 1024);
        assert_eq!(tail.tracks[0].next_slot, None);
    }

    #[tokio::test]
    async fn lost_or_short_session_pages_keep_read_data_and_report_the_gap() {
        for malformed in [false, true] {
            let q = fake_live(FakeLive {
                clips: vec![vec![Some("clip".into()); 40]],
                midi: vec![true],
                paged_only: true,
                silent_page: (!malformed).then_some(16),
                malformed_page: malformed.then_some(16),
                ..Default::default()
            })
            .await;
            let map = get_clips(q, 1, Duration::from_millis(100)).await;
            assert_eq!(map.missing, vec![0]);
            assert_eq!(map.tracks[0].clips.len(), 16);
            assert_eq!(map.tracks[0].next_slot, Some(16));
        }
    }

    #[tokio::test]
    async fn a_scene_count_change_does_not_merge_two_session_grids() {
        let q = fake_live(FakeLive {
            clips: vec![vec![Some("clip".into()); 40]],
            midi: vec![true],
            paged_only: true,
            changed_total_page: Some(16),
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 1, QUERY_TIMEOUT).await;
        assert_eq!(map.missing, vec![0]);
        assert!(map.tracks.is_empty());
    }

    #[tokio::test]
    async fn every_track_request_goes_out_before_any_reply_is_awaited() {
        // The load-bearing performance claim: AbletonOSC serves all pending
        // requests inside one Live tick, so 2N in flight is one tick, and
        // serialising would cost one tick per track.
        let q = fake_live(FakeLive {
            clips: vec![slots(&[Some("A")]), slots(&[Some("B")]), slots(&[])],
            midi: vec![true, true, false],
            hold_until_all_arrive: Some(6),
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 3, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks.len(), 3);
        assert!(map.missing.is_empty());
    }

    #[tokio::test]
    async fn a_silent_track_is_named_in_missing_not_dropped() {
        let q = fake_live(FakeLive {
            clips: vec![
                slots(&[Some("A")]),
                slots(&[Some("B")]),
                slots(&[Some("C")]),
            ],
            midi: vec![true, true, true],
            silent: vec![1],
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 3, Duration::from_millis(300)).await;
        assert_eq!(map.missing, vec![1]);
        assert_eq!(
            map.tracks.iter().map(|t| t.track).collect::<Vec<_>>(),
            vec![0, 2]
        );
    }

    #[tokio::test]
    async fn a_lost_midi_flag_leaves_none_and_names_the_track() {
        // Not `false`: that would read as "audio track, no notes here".
        let q = fake_live(FakeLive {
            clips: vec![slots(&[Some("A")])],
            midi: vec![true],
            silent_midi: vec![0],
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 1, Duration::from_millis(300)).await;
        assert_eq!(map.tracks[0].midi, None);
        assert_eq!(map.midi_missing, vec![0]);
        assert_eq!(map.tracks[0].clips.len(), 1);
    }

    #[tokio::test]
    async fn an_audio_track_is_marked_and_still_lists_its_clips() {
        let q = fake_live(FakeLive {
            clips: vec![slots(&[Some("Vocal Take")])],
            midi: vec![false],
            ..Default::default()
        })
        .await;
        let map = get_clips(q, 1, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks[0].midi, Some(false));
        assert_eq!(map.tracks[0].clips[0].name, "«Vocal Take»");
        assert!(map.midi_missing.is_empty());
    }
}
