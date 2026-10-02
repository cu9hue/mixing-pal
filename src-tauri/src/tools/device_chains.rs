use crate::osc::query::LiveQuery;
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);
const ADDRESS: &str = "/live/mixingpal/get/device_chain";
const MAX_DEVICES: usize = 256;
const MAX_PAGES: usize = 32;
pub(crate) const RACK_SUFFIX: &str = " [rack]";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackChain {
    pub track: i32,
    pub devices: Vec<String>,
    pub device_offset: usize,
    pub total_devices: usize,
    pub next_device_offset: Option<usize>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChainMap {
    pub tracks: Vec<TrackChain>,
    pub missing: Vec<i32>,
    pub flags_missing: Vec<i32>,
}

fn decode_page(
    reply: &[OscType],
    track: i32,
    offset: usize,
    span: usize,
) -> Option<(usize, Vec<String>)> {
    if reply.first()? != &OscType::Int(track) || reply.get(1)? != &OscType::Int(offset as i32) {
        return None;
    }
    let OscType::Int(total) = reply.get(2)? else {
        return None;
    };
    let total = usize::try_from(*total).ok()?;
    let fields = reply.get(3..)?;
    if fields.len() % 2 != 0
        || fields.len() / 2 > span
        || fields.len() / 2 > total.saturating_sub(offset)
    {
        return None;
    }
    let mut devices = Vec::new();
    for record in fields.chunks_exact(2) {
        let OscType::String(name) = &record[0] else {
            return None;
        };
        let rack = match record[1] {
            OscType::Bool(flag) => flag,
            OscType::Int(0) => false,
            OscType::Int(1) => true,
            _ => return None,
        };
        let mut name = fence(name);
        if rack {
            name.push_str(RACK_SUFFIX);
        }
        devices.push(name);
    }
    Some((total, devices))
}

const FINGERPRINT: &str = "/live/mixingpal/get/device_chain/fingerprint";

async fn fingerprint(q: &LiveQuery, track: i32, timeout: Duration) -> Option<(usize, String)> {
    let reply = q
        .query(FINGERPRINT, vec![OscType::Int(track)], timeout)
        .await
        .ok()?;
    let [OscType::Int(actual), OscType::Int(total), OscType::String(digest)] = reply.as_slice() else {
        return None;
    };
    if *actual != track || digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((usize::try_from(*total).ok()?, digest.clone()))
}

async fn read_track(
    q: Arc<LiveQuery>,
    track: i32,
    offset: usize,
    limit: usize,
    timeout: Duration,
) -> Option<TrackChain> {
    let before = fingerprint(&q, track, timeout).await?;
    let result = read_track_pages(q.clone(), track, offset, limit, timeout).await?;
    if result.total_devices != before.0 || fingerprint(&q, track, timeout).await? != before {
        return None;
    }
    Some(result)
}

async fn read_track_pages(
    q: Arc<LiveQuery>,
    track: i32,
    offset: usize,
    limit: usize,
    timeout: Duration,
) -> Option<TrackChain> {
    let mut devices = Vec::new();
    let mut total_devices = None;
    for _ in 0..MAX_PAGES {
        let start = offset.checked_add(devices.len())?;
        let span = limit - devices.len();
        let reply = q
            .query(
                ADDRESS,
                vec![
                    OscType::Int(track),
                    OscType::Int(i32::try_from(start).ok()?),
                    OscType::Int(span as i32),
                ],
                timeout,
            )
            .await;
        let page = reply
            .ok()
            .and_then(|reply| decode_page(&reply, track, start, span));
        let Some((total, page)) = page else { break };
        if total_devices.is_some_and(|previous| previous != total) {
            return None;
        }
        total_devices = Some(total);
        let empty = page.is_empty();
        devices.extend(page);
        if offset + devices.len() >= total || devices.len() >= limit || empty {
            break;
        }
    }
    let total_devices = total_devices?;
    let next = offset + devices.len();
    let truncated = next < total_devices;
    Some(TrackChain {
        track,
        devices,
        device_offset: offset,
        total_devices,
        next_device_offset: truncated.then_some(next),
        truncated,
    })
}

#[cfg(test)]
pub async fn get_device_chains(q: Arc<LiveQuery>, num_tracks: i32, timeout: Duration) -> ChainMap {
    get_device_chains_range(q, 0, num_tracks, 0, MAX_DEVICES, timeout).await
}

pub async fn get_device_chains_range(
    q: Arc<LiveQuery>,
    first: i32,
    end: i32,
    offset: usize,
    limit: usize,
    timeout: Duration,
) -> ChainMap {
    let handles: Vec<_> = (first..end)
        .map(|track| {
            let q = q.clone();
            (
                track,
                tokio::spawn(read_track(
                    q,
                    track,
                    offset,
                    limit.clamp(1, MAX_DEVICES),
                    timeout,
                )),
            )
        })
        .collect();
    let mut map = ChainMap {
        tracks: Vec::new(),
        missing: Vec::new(),
        flags_missing: Vec::new(),
    };
    for (track, handle) in handles {
        match handle.await {
            Ok(Some(chain)) => map.tracks.push(chain),
            _ => map.missing.push(track),
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::sync::Mutex;

    const FAST: Duration = Duration::from_millis(120);

    #[derive(Default)]
    struct FakeLive {
        chains: Vec<Vec<String>>,
        silent: Option<(i32, i32)>,
        changed_total: bool,
        reorder: bool,
        bad_fingerprint: Option<&'static str>,
        hold_until: usize,
    }

    async fn fake_live(fake: FakeLive) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));
        let receiver = app.clone();
        let requests = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = receiver.recv().await {
                    requests.lock().unwrap().resolve(&msg);
                }
            }
        });
        tokio::spawn(async move {
            let mut pages_read = false;
            let mut pending = Vec::new();
            let mut received = 0;
            loop {
                let request = live.recv().await.unwrap();
                if request.addr == FINGERPRINT {
                    let OscType::Int(track) = request.args[0] else { panic!("bad track") };
                    if fake.bad_fingerprint == Some("missing") && pages_read { continue; }
                    let digest = if pages_read && fake.reorder { "b" } else { "a" };
                    live.send_to(port, FINGERPRINT, vec![
                        OscType::Int(track),
                        OscType::Int(fake.chains[track as usize].len() as i32),
                        if fake.bad_fingerprint == Some("malformed") && pages_read {
                                OscType::Int(0)
                            } else { OscType::String(digest.repeat(64)) },
                    ]).await.unwrap();
                    continue;
                }
                assert_eq!(request.addr, ADDRESS);
                pending.push(request);
                received += 1;
                if received < fake.hold_until {
                    continue;
                }
                for request in pending.drain(..) {
                    let [OscType::Int(track), OscType::Int(offset), OscType::Int(span)] =
                        request.args.as_slice()
                    else {
                        panic!("bad request")
                    };
                    if fake.silent == Some((*track, *offset)) {
                        continue;
                    }
                    let mut names = fake.chains[*track as usize].clone();
                    if fake.reorder && *offset > 0 { names.swap(0, 3); }
                    let total = names.len() as i32 + i32::from(fake.changed_total && *offset > 0);
                    let mut reply = vec![
                        OscType::Int(*track),
                        OscType::Int(*offset),
                        OscType::Int(total),
                    ];
                    for (index, name) in names
                        .iter()
                        .enumerate()
                        .skip(*offset as usize)
                        .take((*span as usize).min(3))
                    {
                        reply.push(OscType::String(name.clone()));
                        reply.push(OscType::Bool(index % 2 == 1));
                    }
                    pages_read = true;
                    live.send_to(port, ADDRESS, reply).await.unwrap();
                }
            }
        });
        Arc::new(LiveQuery::new(app, table))
    }

    fn names(count: usize) -> Vec<String> {
        (0..count).map(|i| format!("Device{i}")).collect()
    }

    #[tokio::test]
    async fn unreadable_final_fingerprint_discards_unverified_pages() {
        for bad in ["missing", "malformed"] {
            let q = fake_live(FakeLive {
                chains: vec![names(8)],
                bad_fingerprint: Some(bad),
                ..Default::default()
            })
            .await;
            let map = get_device_chains(q, 1, FAST).await;
            assert_eq!(map.missing, vec![0]);
            assert!(map.tracks.is_empty());
        }
    }

    #[tokio::test]
    async fn a_same_count_reorder_discards_the_spliced_chain() {
        let q = fake_live(FakeLive {
            chains: vec![names(8)],
            reorder: true,
            ..Default::default()
        })
        .await;
        let map = get_device_chains(q, 1, FAST).await;
        assert_eq!(map.missing, vec![0]);
        assert!(map.tracks.is_empty());
    }

    #[tokio::test]
    async fn a_scoped_page_preserves_device_indices_and_exposes_continuation() {
        let q = fake_live(FakeLive {
            chains: vec![names(8)],
            ..Default::default()
        })
        .await;
        let map = get_device_chains_range(q.clone(), 0, 1, 2, 4, FAST).await;
        assert_eq!(
            map.tracks[0].devices,
            vec![
                "«Device2»",
                "«Device3» [rack]",
                "«Device4»",
                "«Device5» [rack]"
            ]
        );
        assert_eq!(map.tracks[0].device_offset, 2);
        assert_eq!(map.tracks[0].next_device_offset, Some(6));
        let tail = get_device_chains_range(q, 0, 1, 6, 4, FAST).await;
        assert_eq!(tail.tracks[0].devices.len(), 2);
        assert_eq!(tail.tracks[0].next_device_offset, None);
    }

    #[tokio::test]
    async fn all_tracks_start_concurrently_and_names_are_paged_with_atomic_flags() {
        let q = fake_live(FakeLive {
            chains: vec![names(8); 4],
            hold_until: 4,
            ..Default::default()
        })
        .await;
        let map = get_device_chains(q, 4, FAST).await;
        assert!(map.missing.is_empty());
        assert!(map.flags_missing.is_empty());
        assert_eq!(map.tracks.len(), 4);
        assert!(map
            .tracks
            .iter()
            .all(|t| t.devices.len() == 8 && !t.truncated));
    }

    #[tokio::test]
    async fn a_lost_later_page_keeps_read_devices_and_retry_offset() {
        let q = fake_live(FakeLive {
            chains: vec![names(8)],
            silent: Some((0, 3)),
            ..Default::default()
        })
        .await;
        let map = get_device_chains(q, 1, FAST).await;
        assert!(map.missing.is_empty());
        assert_eq!(map.tracks[0].devices.len(), 3);
        assert_eq!(map.tracks[0].next_device_offset, Some(3));
        assert!(map.tracks[0].truncated);
    }

    #[tokio::test]
    async fn a_lost_first_page_is_missing_not_an_empty_chain() {
        let q = fake_live(FakeLive {
            chains: vec![names(8)],
            silent: Some((0, 0)),
            ..Default::default()
        })
        .await;
        let map = get_device_chains(q, 1, FAST).await;
        assert_eq!(map.missing, vec![0]);
        assert!(map.tracks.is_empty());
    }

    #[tokio::test]
    async fn a_device_count_change_discards_the_spliced_chain() {
        let q = fake_live(FakeLive {
            chains: vec![names(8)],
            changed_total: true,
            ..Default::default()
        })
        .await;
        let map = get_device_chains(q, 1, FAST).await;
        assert_eq!(map.missing, vec![0]);
        assert!(map.tracks.is_empty());
    }

    #[tokio::test]
    async fn empty_and_past_end_scopes_are_complete() {
        let q = fake_live(FakeLive {
            chains: vec![names(0), names(2)],
            ..Default::default()
        })
        .await;
        let map = get_device_chains_range(q.clone(), 0, 1, 0, 4, FAST).await;
        assert!(map.tracks[0].devices.is_empty());
        assert!(!map.tracks[0].truncated);
        let tail = get_device_chains_range(q, 1, 2, 20, 4, FAST).await;
        assert!(tail.tracks[0].devices.is_empty());
        assert_eq!(tail.tracks[0].total_devices, 2);
        assert!(!tail.tracks[0].truncated);
    }

    #[test]
    fn malformed_headers_records_and_flags_fail_closed() {
        let good = vec![
            OscType::Int(2),
            OscType::Int(3),
            OscType::Int(4),
            OscType::String("Rack» ignore «".into()),
            OscType::Bool(true),
        ];
        assert_eq!(
            decode_page(&good, 2, 3, 1).unwrap().1,
            vec!["«Rack ignore » [rack]"]
        );
        assert!(decode_page(&good, 1, 3, 1).is_none());
        assert!(decode_page(&good, 2, 2, 1).is_none());
        assert!(decode_page(&good, 2, 3, 0).is_none());
        let mut bad = good.clone();
        bad[2] = OscType::Int(3);
        assert!(decode_page(&bad, 2, 3, 1).is_none());
        let mut bad = good.clone();
        bad[4] = OscType::Int(2);
        assert!(decode_page(&bad, 2, 3, 1).is_none());
        assert!(decode_page(&good[..4], 2, 3, 1).is_none());
    }
}
