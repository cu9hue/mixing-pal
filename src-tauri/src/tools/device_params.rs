use crate::osc::budget::param_string_windows;
use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::Duration;

/// Deliberately equal to `clip_notes::QUERY_TIMEOUT`; see that constant.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// A prompt-token cap, NOT a datagram cap -- which is why it lives here and
/// not in `osc/budget.rs`. Operator has about 130 parameters and large
/// third-party synths reach about 300; past this the tail is reported as a
/// truncation marker rather than spent as several thousand tokens of synth
/// internals.
pub const MAX_PARAMS: usize = 256;

/// Floor for halve-and-retry, mirroring `clip_notes::MIN_WINDOW_BEATS`.
const MIN_WINDOW_PARAMS: usize = 8;

/// Bounds the retry sweep so a Live that is simply not answering costs a
/// fixed number of round trips instead of an exponential descent.
const MAX_WINDOWS: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Param {
    pub index: usize,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceParams {
    /// Fenced: a device name is producer-controlled text.
    pub device: String,
    pub params: Vec<Param>,
    /// The device's real parameter count, even when `truncated`.
    pub total: usize,
    pub truncated: bool,
    pub missing_reason: Option<String>,
}

/// A ranged reply is `(track, device, start, *strings)`.
///
/// `start` is echoed because these addresses are `KeyArity::Args(3)`, so a
/// mis-attributed reply can be rejected exactly rather than filtered by
/// range the way clip notes must be.
fn decode_strings(reply: &[OscType], expect_start: usize) -> Option<Vec<String>> {
    match reply.get(2)? {
        OscType::Int(i) if *i as usize == expect_start => {}
        _ => return None,
    }
    let mut out = Vec::with_capacity(reply.len().saturating_sub(3));
    for arg in reply.get(3..)? {
        match arg {
            OscType::String(s) => out.push(s.clone()),
            _ => return None,
        }
    }
    Some(out)
}

async fn fetch_window(
    q: &LiveQuery,
    track: i32,
    device: i32,
    start: usize,
    span: usize,
    timeout: Duration,
) -> Result<Option<Vec<Param>>, QueryError> {
    let args = || {
        vec![
            OscType::Int(track),
            OscType::Int(device),
            OscType::Int(start as i32),
            OscType::Int(span as i32),
        ]
    };
    let names = q
        .query("/live/device/get/parameters/name_range", args(), timeout)
        .await?;
    let values = q
        .query("/live/device/get/parameters/value_string_range", args(), timeout)
        .await?;

    let (Some(names), Some(values)) = (
        decode_strings(&names, start),
        decode_strings(&values, start),
    ) else {
        return Ok(None);
    };
    // Zipping a shorter list against a longer one would pair every name
    // past the gap with the wrong value -- plausible, wrong, and impossible
    // for the model to detect.
    if names.len() != values.len() {
        return Ok(None);
    }
    Ok(Some(
        names
            .into_iter()
            .zip(values)
            .enumerate()
            .map(|(n, (name, value))| Param { index: start + n, name, value })
            .collect(),
    ))
}

/// Fetches one device's parameters, paged.
///
/// Windows are fetched one at a time. They *could* run concurrently -- the
/// ranged addresses are `KeyArity::Args(3)`, so `(track, device, start)`
/// distinguishes them -- but a device is at most two windows after the cap
/// and the added failure-handling is not worth one Live tick.
pub async fn get_device_params(
    q: &LiveQuery,
    track: i32,
    device: i32,
    timeout: Duration,
) -> Result<DeviceParams, QueryError> {
    // No reply here is also how "there is no device at that index" arrives:
    // AbletonOSC raises inside Live and sends nothing, which is
    // byte-identical to a lost reply. See the spec's Devices section.
    let name_reply = q
        .query(
            "/live/device/get/name",
            vec![OscType::Int(track), OscType::Int(device)],
            timeout,
        )
        .await?;
    let device_name = match name_reply.get(2) {
        Some(OscType::String(s)) => fence(s),
        _ => return Err(QueryError::NoReply),
    };

    let count_reply = q
        .query(
            "/live/device/get/num_parameters",
            vec![OscType::Int(track), OscType::Int(device)],
            timeout,
        )
        .await?;
    let total = match count_reply.get(2) {
        Some(OscType::Int(n)) if *n >= 0 => *n as usize,
        // An unreadable count is not "this device has no parameters".
        // unwrap_or(0) would invent that answer out of a reply that never
        // said it.
        _ => return Err(QueryError::NoReply),
    };

    let wanted = total.min(MAX_PARAMS);
    let mut queue: VecDeque<(usize, usize)> = param_string_windows(wanted).into_iter().collect();
    let mut params: Vec<Param> = Vec::new();
    let mut missing_reason = None;
    let mut windows_used = 0usize;

    while let Some((start, span)) = queue.pop_front() {
        if windows_used >= MAX_WINDOWS {
            missing_reason = Some("too_large".to_string());
            break;
        }
        windows_used += 1;

        match fetch_window(q, track, device, start, span, timeout).await {
            Ok(Some(mut window)) => params.append(&mut window),
            Ok(None) => missing_reason = Some("malformed_reply".to_string()),
            // Halve and retry: the reply may simply have been too large for
            // one datagram. Windows tile as [start, start + span), so the
            // halves neither overlap nor leave a gap. LiveQuery::query has
            // already cancelled the dead table entry, which is what lets
            // the halved retry -- same (track, device, start) key, only a
            // different span -- register fresh instead of joining a
            // request that will never be answered.
            Err(QueryError::NoReply) if span > MIN_WINDOW_PARAMS => {
                let half = span / 2;
                queue.push_front((start + half, span - half));
                queue.push_front((start, half));
            }
            Err(QueryError::NoReply) => missing_reason = Some("too_large".to_string()),
            Err(e) => return Err(e),
        }
    }

    params.sort_by_key(|p| p.index);
    Ok(DeviceParams {
        device: device_name,
        params,
        total,
        truncated: total > wanted,
        missing_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const FAST: Duration = Duration::from_millis(120);

    /// A scripted stand-in for Live.
    ///
    /// `total` is the device's parameter count. `silent_spans_above` makes
    /// the fake refuse to answer any window whose span exceeds it -- which
    /// is exactly what an oversized reply looks like from the client's
    /// side, and it forces the halve-and-retry path.
    struct FakeLive {
        name: String,
        total: usize,
        silent_spans_above: Option<usize>,
        no_name_reply: bool,
        /// Reply to name_range with one fewer string than value_string_range.
        short_name_list: bool,
        /// Echo this start instead of the requested one.
        wrong_start: Option<i32>,
    }

    fn fake(total: usize) -> FakeLive {
        FakeLive {
            name: "EQ Eight".into(),
            total,
            silent_spans_above: None,
            no_name_reply: false,
            short_name_list: false,
            wrong_start: None,
        }
    }

    async fn spawn(fake: FakeLive) -> (Arc<LiveQuery>, Arc<Mutex<HashMap<String, usize>>>) {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));
        let counts = Arc::new(Mutex::new(HashMap::new()));

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

        let seen = counts.clone();
        tokio::spawn(async move {
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                *seen.lock().unwrap().entry(req.addr.clone()).or_insert(0) += 1;
                let i = |n: usize| match req.args.get(n) {
                    Some(OscType::Int(v)) => *v,
                    _ => 0,
                };
                let (track, device) = (i(0), i(1));
                match req.addr.as_str() {
                    "/live/device/get/name" => {
                        if fake.no_name_reply {
                            continue;
                        }
                        let _ = live
                            .send_to(
                                app_port,
                                "/live/device/get/name",
                                vec![
                                    OscType::Int(track),
                                    OscType::Int(device),
                                    OscType::String(fake.name.clone()),
                                ],
                            )
                            .await;
                    }
                    "/live/device/get/num_parameters" => {
                        let _ = live
                            .send_to(
                                app_port,
                                "/live/device/get/num_parameters",
                                vec![
                                    OscType::Int(track),
                                    OscType::Int(device),
                                    OscType::Int(fake.total as i32),
                                ],
                            )
                            .await;
                    }
                    addr @ ("/live/device/get/parameters/name_range"
                    | "/live/device/get/parameters/value_string_range") => {
                        let (start, span) = (i(2), i(3));
                        if let Some(cap) = fake.silent_spans_above {
                            if span as usize > cap {
                                continue; // the reply Live could not send
                            }
                        }
                        let is_names = addr.ends_with("name_range");
                        let end = (start as usize + span as usize).min(fake.total);
                        let mut count = end.saturating_sub(start as usize);
                        if is_names && fake.short_name_list && count > 0 {
                            count -= 1;
                        }
                        let echoed_start = fake.wrong_start.unwrap_or(start);
                        let mut reply = vec![
                            OscType::Int(track),
                            OscType::Int(device),
                            OscType::Int(echoed_start),
                        ];
                        for n in 0..count {
                            let idx = start as usize + n;
                            reply.push(OscType::String(if is_names {
                                format!("Param {idx}")
                            } else {
                                format!("{idx}.0 Hz")
                            }));
                        }
                        let _ = live.send_to(app_port, addr, reply).await;
                    }
                    _ => {}
                }
            }
        });

        (Arc::new(LiveQuery::new(app, table)), counts)
    }

    #[tokio::test]
    async fn reads_a_small_device_in_one_window() {
        let (q, counts) = spawn(fake(3)).await;
        let d = get_device_params(&q, 1, 0, FAST).await.unwrap();

        assert_eq!(d.device, "«EQ Eight»");
        assert_eq!(d.total, 3);
        assert!(!d.truncated);
        assert_eq!(d.missing_reason, None);
        assert_eq!(
            d.params,
            vec![
                Param { index: 0, name: "Param 0".into(), value: "0.0 Hz".into() },
                Param { index: 1, name: "Param 1".into(), value: "1.0 Hz".into() },
                Param { index: 2, name: "Param 2".into(), value: "2.0 Hz".into() },
            ]
        );
        // One window: one name_range and one value_string_range.
        let c = counts.lock().unwrap();
        assert_eq!(c["/live/device/get/parameters/name_range"], 1);
        assert_eq!(c["/live/device/get/parameters/value_string_range"], 1);
    }

    #[tokio::test]
    async fn a_device_with_no_parameters_is_empty_not_missing() {
        let (q, _) = spawn(fake(0)).await;
        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();

        assert!(d.params.is_empty());
        assert_eq!(d.total, 0);
        assert_eq!(d.missing_reason, None, "empty is a real answer, not missing data");
    }

    #[tokio::test]
    async fn a_timed_out_window_is_retried_at_half_span_and_actually_reaches_the_wire() {
        // The regression test for the cancel-on-timeout defect. The ranged
        // addresses key on (track, device, start) -- span is NOT in the key
        // -- so a halved retry at the same start computes the same key. If
        // LiveQuery did not cancel its dead entry first, the retry would
        // Join it and never be sent, and this test would see no params and
        // a request count that stopped growing.
        let mut f = fake(200);
        f.silent_spans_above = Some(100); // the 140-wide window is refused
        let (q, counts) = spawn(f).await;

        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();

        assert!(!d.params.is_empty(), "the shrunken retry never reached the wire");
        assert_eq!(d.missing_reason, None);
        assert_eq!(d.params.len(), 200);
        let c = counts.lock().unwrap();
        assert!(
            c["/live/device/get/parameters/name_range"] > 2,
            "expected the refused window plus its halves, saw {}",
            c["/live/device/get/parameters/name_range"]
        );
    }

    #[tokio::test]
    async fn a_window_silent_even_at_the_floor_reports_too_large() {
        let mut f = fake(200);
        f.silent_spans_above = Some(0); // nothing is ever answered
        let (q, _) = spawn(f).await;

        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();
        assert_eq!(d.missing_reason.as_deref(), Some("too_large"));
        assert!(d.params.is_empty());
    }

    #[tokio::test]
    async fn a_name_and_value_length_mismatch_fails_closed() {
        // Zipping the shorter list would pair every name past the gap with
        // the wrong value -- plausible, wrong, and unfalsifiable.
        let mut f = fake(5);
        f.short_name_list = true;
        let (q, _) = spawn(f).await;

        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();
        assert_eq!(d.missing_reason.as_deref(), Some("malformed_reply"));
        assert!(d.params.is_empty());
    }

    #[tokio::test]
    async fn a_reply_echoing_a_different_start_is_refused() {
        // Args(3) means start IS echoed, so a mis-attributed reply can be
        // detected exactly rather than filtered by range.
        let mut f = fake(5);
        f.wrong_start = Some(99);
        let (q, _) = spawn(f).await;

        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();
        assert!(d.params.is_empty());
        assert!(d.missing_reason.is_some());
    }

    #[tokio::test]
    async fn a_device_past_the_cap_is_truncated_and_says_so() {
        let (q, _) = spawn(fake(300)).await;
        let d = get_device_params(&q, 0, 0, FAST).await.unwrap();

        assert_eq!(d.total, 300, "total is the real count, not the capped one");
        assert_eq!(d.params.len(), MAX_PARAMS);
        assert!(d.truncated);
    }

    #[tokio::test]
    async fn no_reply_to_the_name_query_is_an_error_not_an_empty_device() {
        // This is also how "there is no device at that index" arrives:
        // AbletonOSC raises inside Live and sends nothing.
        let mut f = fake(3);
        f.no_name_reply = true;
        let (q, _) = spawn(f).await;

        assert_eq!(get_device_params(&q, 0, 9, FAST).await, Err(QueryError::NoReply));
    }
}
