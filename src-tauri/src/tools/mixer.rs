use crate::osc::query::LiveQuery;
use crate::tools::device_chains::decode_device;
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Send {
    /// Fenced: a return track's name is producer-controlled text.
    pub to: String,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub automation: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackMix {
    pub track: i32,
    pub volume: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_automation: Option<&'static str>,
    pub pan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_automation: Option<&'static str>,
    /// Fenced: often another track's name, such as a bus.
    pub output: String,
    /// The Group track this track sits in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_track: Option<i32>,
    pub sends: Vec<Send>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChannelMix {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<i32>,
    pub name: String,
    pub volume: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_automation: Option<&'static str>,
    pub pan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_automation: Option<&'static str>,
    pub devices: Vec<String>,
    pub total_devices: usize,
    /// The chain was longer than one reply holds.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MixerMap {
    pub tracks: Vec<TrackMix>,
    pub returns: Vec<ChannelMix>,
    pub master: Option<ChannelMix>,
    #[serde(skip)]
    pub missing_tracks: Vec<i32>,
    #[serde(skip)]
    pub missing_returns: Vec<i32>,
}

/// `automation_state`: 0 none, 1 automated, 2 overridden. `None` for anything
/// else, so a reply that is not this shape is refused rather than guessed.
fn automation(value: &OscType) -> Option<Option<&'static str>> {
    match value {
        OscType::Int(0) => Some(None),
        OscType::Int(1) => Some(Some("automated")),
        OscType::Int(2) => Some(Some("overridden")),
        _ => None,
    }
}

fn shown(value: &OscType, state: &OscType) -> Option<(String, Option<&'static str>)> {
    let OscType::String(text) = value else { return None };
    Some((text.clone(), automation(state)?))
}

/// `(track, volume, state, pan, state, output, group, n_sends, *(send, state))`.
/// Send targets are named from `returns` by position, the order Live keeps.
fn decode_track(reply: &[OscType], track: i32, returns: &[String]) -> Option<TrackMix> {
    let [OscType::Int(echo), volume, volume_state, pan, pan_state, OscType::String(output), OscType::Int(group), OscType::Int(count), sends @ ..] = reply else {
        return None;
    };
    if *echo != track || sends.len() != 2 * usize::try_from(*count).ok()? {
        return None;
    }
    let (volume, volume_automation) = shown(volume, volume_state)?;
    let (pan, pan_automation) = shown(pan, pan_state)?;
    let sends = sends
        .chunks_exact(2)
        .enumerate()
        .map(|(i, pair)| {
            let (level, automation) = shown(&pair[0], &pair[1])?;
            let to = returns.get(i).cloned().unwrap_or_else(|| format!("return {i}"));
            Some(Send { to, level, automation })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(TrackMix {
        track,
        volume,
        volume_automation,
        pan,
        pan_automation,
        output: fence(output),
        group_track: (*group >= 0).then_some(*group),
        sends,
    })
}

/// `(name, volume, state, pan, state, n_devices, *device records)`, the tail
/// shared by return and master replies.
fn decode_channel(index: Option<i32>, fields: &[OscType]) -> Option<ChannelMix> {
    let [OscType::String(name), volume, volume_state, pan, pan_state, OscType::Int(total), records @ ..] = fields else {
        return None;
    };
    let total_devices = usize::try_from(*total).ok()?;
    if records.len() % 5 != 0 || records.len() / 5 > total_devices {
        return None;
    }
    let devices = records
        .chunks_exact(5)
        .map(|record| decode_device(record).map(|(label, _)| label))
        .collect::<Option<Vec<_>>>()?;
    let (volume, volume_automation) = shown(volume, volume_state)?;
    let (pan, pan_automation) = shown(pan, pan_state)?;
    Some(ChannelMix {
        index,
        name: fence(name),
        volume,
        volume_automation,
        pan,
        pan_automation,
        truncated: devices.len() < total_devices,
        devices,
        total_devices,
    })
}

fn decode_return(reply: &[OscType], index: i32) -> Option<ChannelMix> {
    let [OscType::Int(echo), OscType::Int(_total), rest @ ..] = reply else { return None };
    (*echo == index).then_some(())?;
    decode_channel(Some(index), rest)
}

async fn return_count(q: &LiveQuery, timeout: Duration) -> Option<i32> {
    let reply = q.query("/live/return/get/num_returns", vec![], timeout).await.ok()?;
    match reply.as_slice() {
        [OscType::Int(n)] if *n >= 0 => Some(*n),
        _ => None,
    }
}

/// Every selected track's mixer, every return, and the master, in one
/// concurrent fan-out. Returns are read first: a send is named by the return
/// it feeds.
pub async fn get_mixer(q: Arc<LiveQuery>, tracks: std::ops::Range<i32>, timeout: Duration) -> MixerMap {
    let num_returns = return_count(&q, timeout).await;
    let return_reads: Vec<_> = (0..num_returns.unwrap_or(0))
        .map(|index| {
            let q = q.clone();
            (index, tokio::spawn(async move {
                let reply = q.query("/live/mixingpal/get/return_mixer", vec![OscType::Int(index)], timeout).await.ok()?;
                decode_return(&reply, index)
            }))
        })
        .collect();
    let master = {
        let q = q.clone();
        tokio::spawn(async move {
            let reply = q.query("/live/mixingpal/get/master_mixer", vec![], timeout).await.ok()?;
            decode_channel(None, &reply)
        })
    };
    let mut map = MixerMap { tracks: vec![], returns: vec![], master: None, missing_tracks: vec![], missing_returns: vec![] };
    if num_returns.is_none() {
        map.missing_returns.push(-1);
    }
    for (index, read) in return_reads {
        match read.await {
            Ok(Some(channel)) => map.returns.push(channel),
            _ => map.missing_returns.push(index),
        }
    }
    let names: Vec<String> = (0..num_returns.unwrap_or(0))
        .map(|i| map.returns.iter().find(|r| r.index == Some(i)).map_or(format!("return {i}"), |r| r.name.clone()))
        .collect();
    let track_reads: Vec<_> = tracks
        .map(|track| {
            let q = q.clone();
            let names = names.clone();
            (track, tokio::spawn(async move {
                let reply = q.query("/live/mixingpal/get/track_mixer", vec![OscType::Int(track)], timeout).await.ok()?;
                decode_track(&reply, track, &names)
            }))
        })
        .collect();
    for (track, read) in track_reads {
        match read.await {
            Ok(Some(mix)) => map.tracks.push(mix),
            _ => map.missing_tracks.push(track),
        }
    }
    map.master = master.await.ok().flatten();
    map
}

/// What a partial read is missing, joined like the other whole-set reads.
pub fn reasons(map: &MixerMap, num_tracks: i64, read_tracks: i64) -> Option<String> {
    let list = |items: &[i32]| items.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ");
    let mut reasons = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!("truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"));
    }
    if !map.missing_tracks.is_empty() {
        reasons.push(format!("no_reply_for_tracks: {}", list(&map.missing_tracks)));
    }
    if map.missing_returns == [-1] {
        reasons.push("return_count_unread: returns and send targets are unknown".into());
    } else if !map.missing_returns.is_empty() {
        reasons.push(format!("no_reply_for_returns: {}", list(&map.missing_returns)));
    }
    if map.master.is_none() {
        reasons.push("no_reply_for_master".into());
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::sync::Mutex;

    fn s(text: &str) -> OscType {
        OscType::String(text.into())
    }

    fn record(name: &str, active: bool, kind: i32, class: &str) -> Vec<OscType> {
        vec![s(name), OscType::Bool(false), OscType::Bool(active), OscType::Int(kind), s(class)]
    }

    #[test]
    fn a_track_names_its_sends_by_return_and_its_group() {
        let reply = vec![
            OscType::Int(3), s("-6.0 dB"), OscType::Int(1), s("C"), OscType::Int(0),
            s("Drums Bus"), OscType::Int(1), OscType::Int(2),
            s("-12.0 dB"), OscType::Int(0), s("-inf dB"), OscType::Int(2),
        ];
        let mix = decode_track(&reply, 3, &["«A-Reverb»".into()]).unwrap();
        assert_eq!(mix.volume_automation, Some("automated"));
        assert_eq!(mix.output, "«Drums Bus»");
        assert_eq!(mix.group_track, Some(1));
        assert_eq!(mix.sends[0], Send { to: "«A-Reverb»".into(), level: "-12.0 dB".into(), automation: None });
        // A send past the returns that answered still says which one it is.
        assert_eq!(mix.sends[1].to, "return 1");
        assert_eq!(mix.sends[1].automation, Some("overridden"));
    }

    #[test]
    fn a_track_reply_of_the_wrong_shape_is_refused() {
        let good = vec![
            OscType::Int(0), s("0.0 dB"), OscType::Int(0), s("C"), OscType::Int(0),
            s("Main"), OscType::Int(-1), OscType::Int(0),
        ];
        assert!(decode_track(&good, 0, &[]).unwrap().group_track.is_none());
        assert!(decode_track(&good, 1, &[]).is_none());
        let mut bad = good.clone();
        bad[2] = OscType::Int(7);
        assert!(decode_track(&bad, 0, &[]).is_none());
        let mut bad = good.clone();
        bad[7] = OscType::Int(1);
        assert!(decode_track(&bad, 0, &[]).is_none());
    }

    #[test]
    fn a_long_chain_says_it_was_cut() {
        let mut reply = vec![OscType::Int(0), OscType::Int(2), s("A-Reverb"), s("0.0 dB"), OscType::Int(0), s("C"), OscType::Int(0), OscType::Int(3)];
        reply.extend(record("Reverb", true, 2, "Reverb"));
        reply.extend(record("Glue", false, 2, "Glue Compressor"));
        let channel = decode_return(&reply, 0).unwrap();
        assert_eq!(channel.name, "«A-Reverb»");
        assert_eq!(channel.devices, vec!["«Reverb»", "«Glue» (Glue Compressor) [off]"]);
        assert!(channel.truncated);
        assert!(decode_return(&reply, 1).is_none());
    }

    async fn fake_live(returns: usize, silent_track: Option<i32>) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));
        let (receiver, requests) = (app.clone(), table.clone());
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = receiver.recv().await {
                    requests.lock().unwrap().resolve(&msg);
                }
            }
        });
        tokio::spawn(async move {
            loop {
                let request = live.recv().await.unwrap();
                let reply = match request.addr.as_str() {
                    "/live/return/get/num_returns" => vec![OscType::Int(returns as i32)],
                    "/live/mixingpal/get/return_mixer" => {
                        let OscType::Int(i) = request.args[0] else { continue };
                        let mut reply = vec![OscType::Int(i), OscType::Int(returns as i32), s(&format!("R{i}")), s("0.0 dB"), OscType::Int(0), s("C"), OscType::Int(0), OscType::Int(1)];
                        reply.extend(record("Reverb", true, 2, "Reverb"));
                        reply
                    }
                    "/live/mixingpal/get/master_mixer" => vec![s("Main"), s("0.0 dB"), OscType::Int(0), s("C"), OscType::Int(0), OscType::Int(0)],
                    "/live/mixingpal/get/track_mixer" => {
                        let OscType::Int(t) = request.args[0] else { continue };
                        if silent_track == Some(t) { continue }
                        let mut reply = vec![OscType::Int(t), s("-3.0 dB"), OscType::Int(0), s("C"), OscType::Int(0), s("Main"), OscType::Int(-1), OscType::Int(returns as i32)];
                        for _ in 0..returns { reply.extend([s("-10.0 dB"), OscType::Int(0)]); }
                        reply
                    }
                    _ => continue,
                };
                live.send_to(port, &request.addr, reply).await.unwrap();
            }
        });
        Arc::new(LiveQuery::new(app, table))
    }

    #[tokio::test]
    async fn reads_tracks_returns_and_master_and_names_what_did_not_answer() {
        let q = fake_live(2, Some(1)).await;
        let map = get_mixer(q, 0..3, Duration::from_millis(150)).await;
        assert_eq!(map.returns.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["«R0»", "«R1»"]);
        assert_eq!(map.tracks.len(), 2);
        assert_eq!(map.tracks[0].sends[1].to, "«R1»");
        assert_eq!(map.master.as_ref().unwrap().name, "«Main»");
        assert_eq!(map.missing_tracks, vec![1]);
        assert_eq!(reasons(&map, 3, 3).as_deref(), Some("no_reply_for_tracks: 1"));
    }
}
