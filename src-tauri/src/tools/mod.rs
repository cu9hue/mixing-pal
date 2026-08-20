pub mod clip_notes;
pub mod device_chains;
pub mod device_params;
pub mod fence;
pub mod path;
pub mod rack_contents;
pub mod track_detail;

use crate::deltas::Coalescer;
use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::path::DevicePath;
use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// What every tool result carries, so the model can tell "Live said zero"
/// from "Live said nothing" from "too large to send" -- and, for a mirror
/// read, how old the value is. Told the age rather than left to imply live
/// truth.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolResult {
    /// `null` when the call produced nothing at all.
    ///
    /// A value AND a `missing_reason` together is a real state, not a
    /// contradiction: a paged clip read that answered some windows and not
    /// others returns the notes it got with `missing_reason: "too_large"`.
    /// `fresh` is false in that case, and the model is expected to say the
    /// read was partial rather than present it as the whole clip.
    pub value: serde_json::Value,
    /// Epoch milliseconds at which this call ran.
    pub queried_at: u64,
    /// Epoch milliseconds at which the underlying value was last observed.
    /// Equal to `queried_at` for a live query; older for a mirror read.
    pub fresh_as_of: Option<u64>,
    pub fresh: bool,
    pub missing_reason: Option<String>,
}

/// Epoch millis. `pub(crate)` so `trace.rs` (via `lib.rs`) uses this exact
/// derivation for a step's `at` field instead of a second implementation.
pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ToolResult {
    fn live(value: serde_json::Value, missing_reason: Option<String>) -> Self {
        let at = now_millis();
        Self {
            fresh: missing_reason.is_none(),
            value,
            queried_at: at,
            fresh_as_of: Some(at),
            missing_reason,
        }
    }

    fn missing(reason: &str) -> Self {
        Self {
            value: serde_json::Value::Null,
            queried_at: now_millis(),
            fresh_as_of: None,
            fresh: false,
            missing_reason: Some(reason.to_string()),
        }
    }
}

/// What `execute` needs to reach the two data sources.
#[derive(Clone)]
pub struct ToolContext {
    pub coalescer: Arc<Mutex<Coalescer>>,
    /// `None` until the OSC socket binds. Managed before the bind attempt so
    /// the command is always answerable: a tool that needs a live query then
    /// reports `not_connected` instead of the window failing with "state not
    /// managed".
    pub query: Arc<Mutex<Option<Arc<LiveQuery>>>>,
}

/// The complete set of tools the model may call.
///
/// Backend-owned. The webview passes a tool NAME and arguments, never a
/// definition, so it cannot widen this list -- see the spec's "Where the
/// split actually falls". The descriptions are part of the contract: they
/// are what tells the model that `get_track_detail` is a cached read and
/// `get_clip_notes` goes to Live.
pub fn tool_schema() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_track_detail",
                "description": "Mixer state for one track: name, fader position, fader in dB, pan, mute, solo. Read from a local mirror that is refreshed about every 2 seconds, so the result carries the age of the data. Does not include devices.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." }
                    },
                    "required": ["track"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_clip_notes",
                "description": "Every MIDI note in one session-view clip, as pitch, start, duration, velocity, mute. Queried from Live at call time. A dense clip is fetched in pieces; if a piece cannot be read the result says so.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "clip": { "type": "integer", "description": "Zero-based clip slot index within that track." }
                    },
                    "required": ["track", "clip"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_device_chains",
                "description": "The device chain on every regular track, in order, named as the producer named them. Return and master tracks are not covered. A Rack is listed as one device, marked [rack]; call get_rack_contents on it to see what is inside. Whether a device is switched on or bypassed is not reported. Queried from Live at call time; one round trip covers the whole set, so calling it is cheap. Call this first to find out which devices exist and what their indices are, then use get_device_params to read one. A track with an empty list genuinely has no devices on it. Tracks that did not answer are listed separately under missing.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_device_params",
                "description": "Every parameter of one device, as a name and a formatted value such as \"80.0 Hz\" or \"-12.0 dB\". Queried from Live at call time and fetched in pages. Device indices come from get_device_chains. The device's on/off switch is itself a parameter, conventionally the first one and named Device On, so a device listed in the chain may be switched off and this is how to find out. On a Rack this returns the Rack's own macros; for the devices inside it use get_rack_contents and then pass a longer path here. A device with more than 256 parameters is truncated and the result says so.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "path": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Zero-based indices from the track to the device, alternating device and chain: [2] is top-level device 2; [2, 0, 1] is device 1 in chain 0 of the rack at device 2. Always an odd number of entries, at most 9. Device indices come from get_device_chains, chain indices from get_rack_contents."
                        }
                    },
                    "required": ["track", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_rack_contents",
                "description": "What is inside one Rack: each chain in order, the devices on it, and for a Drum Rack the MIDI note of its pad. Chains that are muted or soloed are marked; nothing is said about the others. Queried from Live at call time and fetched in pages. Use this when get_device_chains marks a device [rack]. An empty result means either that the device is not a Rack, or that it is an empty one, and the result says which. A rack with more than 64 chains is truncated and the result says so; a chain with more than 32 devices lists only the first 32 names, and its total_devices may exceed the number of names listed. Chain indices from here go into the path of get_device_params to read a device inside the rack, or back into get_rack_contents for a rack nested inside a chain.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "path": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Zero-based indices from the track to the device, alternating device and chain: [2] is top-level device 2; [2, 0, 1] is device 1 in chain 0 of the rack at device 2. Always an odd number of entries, at most 9. Device indices come from get_device_chains, chain indices from get_rack_contents."
                        }
                    },
                    "required": ["track", "path"]
                }
            }
        }
    ])
}

/// Reads a required integer argument. Absent or wrongly typed is reported,
/// never defaulted: answering about track 0 when the model asked about a
/// track it could not name is worse than answering nothing.
///
/// Accepts an f64 too, as long as it's integral: real providers commonly
/// emit floats for integer-typed fields (e.g. `{"track": 1.0}`). A
/// genuinely fractional value (`1.5`) is still refused, not truncated --
/// truncating would answer about a track the model never actually named.
fn int_arg(args: &serde_json::Value, name: &str) -> Option<i64> {
    let value = args.get(name)?;
    if let Some(i) = value.as_i64() {
        return Some(i);
    }
    let f = value.as_f64()?;
    (f.is_finite() && f.fract() == 0.0).then_some(f as i64)
}

/// The `(track, path)` pair both path-addressed tools take.
///
/// A refusal here never reaches the wire, which is the point: an even-length
/// or negative path would resolve inside Live's callback to a device nobody
/// asked about, and a negative index would resolve there rather than fail,
/// because Python slices from the end.
fn track_and_path(args: &serde_json::Value) -> Option<(i64, DevicePath)> {
    let track = int_arg(args, "track").filter(|t| *t >= 0)?;
    Some((track, DevicePath::parse(args.get("path"))?))
}

/// One track's mirrored name, used as its identity across a paged query.
///
/// Live resolves `song.tracks[i]` when it HANDLES a message, not when the
/// client sent it -- so a paged note fetch that straddles a track delete or
/// reorder reads a DIFFERENT clip for its later windows and merges the notes
/// into one answer. Sampling the name at both ends catches that. See the
/// spec's "A generation counter" section for why this beats a counter here:
/// a reorder leaves the track count untouched.
fn track_identity(coalescer: &Mutex<Coalescer>, track: i64) -> Option<serde_json::Value> {
    let c = coalescer.lock().ok()?;
    c.lookup("/live/track/get/name", &[json!(track)])?
        .args
        .get(1)
        .cloned()
}

/// The mirrored track count. `num_tracks` is `KeyArity::None`, so the mirror
/// holds it with no key args and the count is `args[0]`. Shared by
/// `get_device_chains`, which reads it once to size the whole-set fetch and
/// again afterward to detect a topology change.
fn track_count(coalescer: &Mutex<Coalescer>) -> Option<i64> {
    let c = coalescer.lock().ok()?;
    c.lookup("/live/song/get/num_tracks", &[])?
        .args
        .first()?
        .as_i64()
}

/// Whether the track under a paged query moved between two identity samples.
///
/// Abstains when the mirror never held the track to begin with: with nothing
/// to compare against, reporting a change would be a guess, and this is a
/// guard against inventing data rather than a licence to invent a warning.
fn topology_moved(before: &Option<serde_json::Value>, after: &Option<serde_json::Value>) -> bool {
    match (before, after) {
        (None, _) => false,
        // The track fell out of the mirror entirely: a delete that shrank
        // num_tracks past this index (see evict_tracks_at_or_beyond).
        (Some(_), None) => true,
        (Some(b), Some(a)) => b != a,
    }
}

/// Bounds the whole-set device-chain fan-out.
///
/// `get_device_chains` is the only concurrency in this codebase sized by a
/// mirrored value: it spawns one task per track and samples one mirrored
/// name per track at each end of the fetch, all off a count the mirror
/// handed over. A corrupt or absurd count must not become that many tasks
/// or that many samples, so the count is clamped to this ONCE, on the
/// `i64`, before the fan-out, the identity brackets, or the `as i32`
/// narrowing consume it. Clamping later leaves each unclamped consumer
/// holding the raw count, and `as i32` alone WRAPS: `2^32 + 5` narrows to
/// 5.
///
/// A real set is nowhere near this, and it is not unreachable either: only
/// Live Intro (16 tracks) and Lite (8) cap the count -- Standard and Suite
/// do not. A set past this is legal, so the result reports the truncation
/// instead of presenting the first `MAX_FANOUT_TRACKS` tracks as the set.
const MAX_FANOUT_TRACKS: i64 = 512;

/// Whether the device-chain read's bracket caught a topology change.
///
/// A count comparison alone catches an add or a delete but misses a
/// same-count REORDER: the indices in the returned `TrackChain` list would
/// then silently name the wrong tracks' devices, and the result would go
/// back as a fresh, fully-formed answer with nothing marking it wrong. So
/// this compares every sampled index's mirrored name too, via the same
/// `topology_moved` rule `get_clip_notes` and `get_device_params` use for
/// one track -- an index the mirror never held abstains rather than
/// reporting a change, exactly as `topology_moved` already does.
///
/// Sampling every index doubles the `track_identity` calls, not the OSC
/// traffic: `track_identity` and `track_count` both read the local mirror,
/// which is already kept warm by the periodic poll, so this costs nothing
/// on the wire.
///
/// NARROWED, NOT CLOSED, and bounded by mirror staleness -- do not read
/// this as a complete reorder guard. Every value it compares, names and
/// count alike, comes from the SAME mirror, which the poll refreshes about
/// every two seconds (`PollKind::TrackState`). So the guard fires only when
/// a poll lands between the two samples. A whole-set fetch finishes in
/// about one Live tick (~100 ms), so on a healthy set most calls sample
/// the same poll twice and see nothing; and a reorder in the up-to-2 s
/// window BEFORE the call is invisible to it entirely -- both samples read
/// identically stale names while the fetch reads Live's new ordering, and
/// the returned indices then pair against the stale index-to-name lines in
/// the context block.
///
/// It is kept because its coverage grows with exactly the calls that need
/// it. That COVERAGE -- not the residual -- is (fetch duration / poll
/// interval): about 5% for a ~100 ms fetch against a 2 s poll, which
/// leaves a residual of 1 - (fetch duration / poll interval), roughly
/// 95%. So the guard catches a small fraction of in-flight reorders and
/// is not a completeness guarantee. What it has going for it is that the
/// fraction rises with the calls that need it: a slow set -- timeouts,
/// retries, a fetch stretching toward the 2 s timeout -- is where a track
/// move is both most likely and most likely to be caught.
/// It costs nothing on the wire, so there is no case for dropping it.
/// Closing it properly needs a change Live tells us about, not one we
/// sample: see the spec's "A generation counter".
fn chains_moved(
    before_count: i64,
    after_count: Option<i64>,
    before: &[Option<serde_json::Value>],
    after: &[Option<serde_json::Value>],
) -> bool {
    after_count != Some(before_count) || before.iter().zip(after).any(|(b, a)| topology_moved(b, a))
}

/// Renders `get_rack_contents`'s payload.
///
/// `total_chains` and `is_rack` are omitted entirely when no window ever
/// decoded, rather than serialised as `null`: an explicit null still invites
/// the model to read something into the field, and `is_rack` is the field the
/// tool description makes load-bearing ("the result says which"). A
/// fabricated `false` there sends the model away from a Rack it should have
/// opened.
///
/// Extracted from the `execute` arm so the omission can be tested at all --
/// `RackContents` is never serialised as a struct, so its `skip_serializing_if`
/// attributes are belt-and-braces and this `if let` is the mechanism that
/// actually runs. Same reason `chain_map_reasons` below was extracted.
fn rack_payload(r: &rack_contents::RackContents) -> serde_json::Value {
    let mut payload = json!({ "chains": r.chains, "truncated": r.truncated });
    if let Some(total) = r.total_chains {
        payload["total_chains"] = json!(total);
    }
    if let Some(is_rack) = r.is_rack {
        payload["is_rack"] = json!(is_rack);
    }
    payload
}

/// Assembles `get_device_chains`'s `missing_reason` from the three things
/// that can go partly wrong: a set larger than the fan-out cap, tracks that
/// did not answer at all, and tracks whose device names arrived without
/// their rack marks.
///
/// All three can hold at once, so they are joined rather than one
/// overwriting another. Extracted from the `execute` arm so it can be tested
/// without a connected fake -- inline, the rack-mark case had no test at all.
fn chain_map_reasons(
    num_tracks: i64,
    read_tracks: i64,
    missing: &[i32],
    flags_missing: &[i32],
) -> Option<String> {
    // The truncated tail is named as a count, not pushed into `missing` as
    // thousands of indices: `missing` means "asked, no usable answer", and
    // these were never asked.
    let mut reasons: Vec<String> = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!(
            "truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"
        ));
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!("no_reply_for_tracks: {}", names.join(", ")));
    }
    if !flags_missing.is_empty() {
        let names: Vec<String> = flags_missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "rack_marks_unavailable_for_tracks: {} (their devices are listed, but which are Racks is unknown)",
            names.join(", ")
        ));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

pub async fn execute(ctx: &ToolContext, name: &str, args: &serde_json::Value) -> ToolResult {
    match name {
        "get_track_detail" => {
            let Some(track) = int_arg(args, "track").filter(|t| *t >= 0) else {
                return ToolResult::missing("bad_arguments");
            };
            // Short guard, no await inside: the mirror read is synchronous.
            let found = match ctx.coalescer.lock() {
                Ok(c) => track_detail::get_track_detail(&c, track as u32, Instant::now()),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some((detail, age)) = found else {
                return ToolResult::missing("not_in_mirror");
            };
            let at = now_millis();
            ToolResult {
                value: serde_json::to_value(&detail).unwrap_or(serde_json::Value::Null),
                queried_at: at,
                fresh_as_of: Some(at.saturating_sub(age.as_millis() as u64)),
                fresh: track_detail::is_fresh(age),
                missing_reason: None,
            }
        }
        "get_clip_notes" => {
            let (Some(track), Some(clip)) = (
                int_arg(args, "track").filter(|t| *t >= 0),
                int_arg(args, "clip").filter(|c| *c >= 0),
            ) else {
                return ToolResult::missing("bad_arguments");
            };
            // Clone the Arc out and DROP the guard before awaiting -- a
            // std::sync::Mutex guard is !Send and holding one across an
            // .await would not compile, which is exactly why this codebase
            // uses one.
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Bracket the fetch with an identity sample. A paged read can
            // span several seconds, and merging two clips' notes into one
            // answer is the failure this catches.
            let before = track_identity(&ctx.coalescer, track);
            let outcome = clip_notes::get_clip_notes(
                query,
                track as i32,
                clip as i32,
                clip_notes::QUERY_TIMEOUT,
            )
            .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(notes) => ToolResult::live(
                    json!({ "notes": notes.notes, "count": notes.notes.len() }),
                    notes.missing_reason,
                ),
                Err(QueryError::NoReply) => ToolResult::missing("no_reply"),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_device_chains" => {
            // Without a count there is nothing to iterate. Querying 0..0
            // would return an empty map, which reads as "the set has no
            // devices" -- an invented answer, not a missing one.
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            // Everything below is sized by `read_tracks`, never by
            // `num_tracks`: see MAX_FANOUT_TRACKS.
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Bracket the whole-set read with every track's mirrored name,
            // not just the count -- see `chains_moved` for why the count
            // alone is not enough.
            let before: Vec<Option<serde_json::Value>> =
                (0..read_tracks).map(|t| track_identity(&ctx.coalescer, t)).collect();

            let map = device_chains::get_device_chains(
                query,
                // One spawned task per track -- the widest fan-out in this
                // codebase, and the only one sized by a mirrored value.
                // Already clamped to MAX_FANOUT_TRACKS, which is what makes
                // this narrowing safe.
                read_tracks as i32,
                device_chains::QUERY_TIMEOUT,
            )
            .await;

            let after_count = track_count(&ctx.coalescer);
            let after: Vec<Option<serde_json::Value>> =
                (0..read_tracks).map(|t| track_identity(&ctx.coalescer, t)).collect();
            // The counts compared here are the REAL ones, clamped or not: a
            // set that grew from 600 to 700 tracks moved, and comparing two
            // clamped counts would call that stable.
            if chains_moved(num_tracks, after_count, &before, &after) {
                return ToolResult::missing("topology_changed");
            }

            let missing_reason =
                chain_map_reasons(num_tracks, read_tracks, &map.missing, &map.flags_missing);
            ToolResult::live(
                json!({ "tracks": map.tracks, "missing": map.missing }),
                missing_reason,
            )
        }
        "get_device_params" => {
            let Some((track, path)) = track_and_path(args) else {
                return ToolResult::missing("bad_arguments");
            };
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as get_clip_notes: a paged read can span several
            // seconds, and reading two different devices' parameters into
            // one answer is the failure this catches.
            let before = track_identity(&ctx.coalescer, track);
            let outcome = device_params::get_device_params(
                &query,
                track as i32,
                &path,
                device_params::QUERY_TIMEOUT,
            )
            .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(d) => ToolResult::live(
                    json!({
                        "device": d.device,
                        "params": d.params,
                        "total": d.total,
                        "truncated": d.truncated,
                    }),
                    d.missing_reason,
                ),
                Err(QueryError::NoReply) => ToolResult::missing(
                    "no_reply: the track or the path may not exist, or Live did not answer",
                ),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        "get_rack_contents" => {
            let Some((track, path)) = track_and_path(args) else {
                return ToolResult::missing("bad_arguments");
            };
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as get_device_params: this read pages over
            // several seconds and the producer is, by definition, working in
            // Live while asking. get_rack_contents brackets the DEVICE
            // itself; this one catches the TRACK moving underneath it.
            let before = track_identity(&ctx.coalescer, track);
            let outcome =
                rack_contents::get_rack_contents(&query, track as i32, &path, rack_contents::QUERY_TIMEOUT)
                    .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(r) => {
                    let payload = rack_payload(&r);
                    ToolResult::live(payload, r.missing_reason)
                }
                // Byte-identical to a lost reply, so the wording names both
                // causes rather than picking one. The model gets its indices
                // from get_device_chains and get_rack_contents, so a bad
                // path is a model error rather than a normal path.
                Err(QueryError::NoReply) => ToolResult::missing(
                    "no_reply: the track or the path may not exist, or Live did not answer",
                ),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        _ => ToolResult::missing("unknown_tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deltas::Delta;

    fn disconnected_ctx(c: Coalescer) -> ToolContext {
        ToolContext {
            coalescer: Arc::new(Mutex::new(c)),
            query: Arc::new(Mutex::new(None)),
        }
    }

    fn one_track_mirror() -> Coalescer {
        let mut c = Coalescer::new();
        c.observe_delta(Delta {
            addr: "/live/track/get/name".to_string(),
            args: vec![serde_json::json!(0), serde_json::json!("Bass")],
        });
        c
    }

    /// A `ToolContext` whose Live answers every device-chain query with an
    /// empty chain. Deliberately minimal -- `device_chains`'s own tests own
    /// the wire behaviour of the fan-out; this one only needs the call to
    /// reach its end so the assembled `missing_reason` can be read.
    async fn answering_ctx(c: Coalescer) -> ToolContext {
        use crate::osc::requests::RequestTable;
        use crate::osc::socket::OscSocket;

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
            loop {
                let Ok(req) = live.recv().await else { continue };
                let Some(&rosc::OscType::Int(track)) = req.args.first() else {
                    continue;
                };
                // Echoing just the track index is a track with no devices.
                let _ = live
                    .send_to(app_port, &req.addr, vec![rosc::OscType::Int(track)])
                    .await;
            }
        });

        ToolContext {
            coalescer: Arc::new(Mutex::new(c)),
            query: Arc::new(Mutex::new(Some(Arc::new(LiveQuery::new(app, table))))),
        }
    }

    fn mirror_with_tracks(n: i64) -> Coalescer {
        let mut c = one_track_mirror();
        c.observe_delta(Delta {
            addr: "/live/song/get/num_tracks".to_string(),
            args: vec![serde_json::json!(n)],
        });
        c
    }

    #[test]
    fn get_device_chains_takes_no_arguments() {
        // It reads the whole set; making the model supply a track index would
        // defeat the one round trip that justifies the design.
        let schema = tool_schema();
        let tool = schema
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "get_device_chains")
            .unwrap()
            .clone();
        assert_eq!(tool["function"]["parameters"]["required"].as_array().unwrap().len(), 0);
    }

    fn description_of(name: &str) -> String {
        tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == name)
            .unwrap()["function"]["description"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn the_chain_map_does_not_claim_to_cover_returns_or_master() {
        // It iterates song.tracks; returns and master need
        // /live/return/get/*, a separate address family. A model told it saw
        // the whole mix will report no reverb when the reverb is on a
        // return.
        let description = description_of("get_device_chains");
        assert!(description.contains("every regular track"));
        assert!(description.contains("Return and master tracks are not covered"));
    }

    #[test]
    fn the_chain_map_does_not_let_the_model_assume_a_listed_device_is_switched_on() {
        // The chain map carries names and nothing else, so a bypassed EQ is
        // byte-identical to an active one in it. The description is the only
        // channel the model reads -- a limit recorded in the spec alone does
        // not reach it. Without this it describes a bypassed EQ's 80 Hz low
        // cut as if it were shaping the bass.
        assert!(description_of("get_device_chains")
            .contains("Whether a device is switched on or bypassed is not reported"));
    }

    #[test]
    fn the_parameter_read_says_it_does_report_the_on_off_switch() {
        // The mirror image of the test above, and the reason the two are
        // separate: `Device.parameters[0]` is the device's on/off switch,
        // named `Device On`, for built-ins, plugins and Racks alike, and
        // `device_range.py` returns every parameter's name and formatted
        // value verbatim -- so this tool DOES carry bypass state. Copying
        // the chain map's sentence here told the model it knew less than it
        // did, so it discarded true evidence it was already holding.
        let description = description_of("get_device_params");
        assert!(description.contains("on/off switch"));
        assert!(description.contains("Device On"));
        assert!(
            !description.contains("bypassed is not reported"),
            "the chain map's sentence must not come back onto the parameter read"
        );
    }

    #[test]
    fn every_description_that_mentions_a_rack_now_points_at_the_way_in() {
        // The replaced version of this test asserted that both tools said
        // racks were opaque. They no longer are, and a description that
        // still said so would talk the model out of a tool it has.
        assert!(description_of("get_device_chains").contains("get_rack_contents"));
        assert!(description_of("get_device_params").contains("get_rack_contents"));
    }

    #[test]
    fn the_rack_tool_says_what_an_empty_result_means() {
        // Zero chains has two causes and only one is a model error, so the
        // description has to name both -- "this rack is empty" is a real
        // observation about a set.
        let d = description_of("get_rack_contents");
        assert!(d.contains("not a Rack"));
        assert!(d.contains("empty"));
    }

    #[test]
    fn both_path_tools_require_a_path_and_no_device_index() {
        for name in ["get_device_params", "get_rack_contents"] {
            let schema = tool_schema();
            let tool = schema
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["function"]["name"] == name)
                .unwrap()
                .clone();
            let required = tool["function"]["parameters"]["required"].as_array().unwrap();
            assert!(required.iter().any(|r| r == "track"), "{name}");
            assert!(required.iter().any(|r| r == "path"), "{name}");
            // Two ways to name one device is an ambiguity a model resolves
            // badly and inconsistently.
            assert!(tool["function"]["parameters"]["properties"]["device"].is_null(), "{name}");
        }
    }

    #[test]
    fn the_schema_offers_all_three_device_tools() {
        let schema = tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        for expected in ["get_device_chains", "get_device_params", "get_rack_contents"] {
            assert!(names.contains(&expected), "{expected}");
        }
    }

    #[tokio::test]
    async fn a_malformed_path_is_refused_before_it_reaches_the_wire() {
        let ctx = disconnected_ctx(one_track_mirror());
        for path in [json!([]), json!([0, 1]), json!([-1]), json!("0.1")] {
            let r = execute(&ctx, "get_rack_contents", &json!({ "track": 0, "path": path })).await;
            assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"), "{path}");
        }
    }

    #[tokio::test]
    async fn get_device_chains_without_a_track_count_says_so() {
        // Reports why it could not run instead of querying track 0..0 and
        // returning an empty map, which would read as "the set has no
        // devices".
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_device_chains", &json!({})).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_in_mirror"));
    }

    #[tokio::test]
    async fn get_device_chains_reads_the_track_count_from_the_mirror() {
        // Pins the lookup shape: num_tracks is KeyArity::None, so the mirror
        // holds it with no key args and the count is args[0]. If this ever
        // drifts, the tool silently degrades to not_in_mirror.
        let ctx = disconnected_ctx(mirror_with_tracks(8));
        let r = execute(&ctx, "get_device_chains", &json!({})).await;
        assert_eq!(
            r.missing_reason.as_deref(),
            Some("not_connected"),
            "got past the mirror read and failed on the socket, as expected"
        );
    }

    #[tokio::test]
    async fn a_track_count_past_the_fan_out_clamp_is_reported_as_truncated() {
        // Live Standard and Suite put no ceiling on the track count, so a
        // set past the clamp is unusual but legal. Returning the first 512
        // tracks with `missing` empty and `missing_reason: null` would tell
        // the model it saw "every regular track", exactly what the tool
        // description promises -- when it saw 512 of 600.
        let ctx = answering_ctx(mirror_with_tracks(600)).await;
        let r = execute(&ctx, "get_device_chains", &json!({})).await;

        let reason = r.missing_reason.clone().unwrap_or_default();
        assert!(reason.starts_with("truncated_to_first_512_tracks"), "{reason}");
        assert!(reason.contains("600"), "the real count has to be named: {reason}");
        assert!(!r.fresh, "a truncated map is not a complete read of the set");

        let tracks = r.value["tracks"].as_array().unwrap();
        let missing = r.value["missing"].as_array().unwrap();
        assert_eq!(
            tracks.len() + missing.len(),
            512,
            "every queried track is accounted for, and none past the clamp was queried"
        );
        assert!(tracks.iter().all(|t| t["track"].as_i64().unwrap() < 512));
    }

    #[tokio::test]
    async fn a_track_count_past_i32_does_not_wrap_into_a_small_fan_out() {
        // 2^32 + 5 narrows to 5 under `as i32`. Clamping on the i64 first is
        // what stops a corrupt mirrored count from turning a whole-set read
        // into a five-track one that reports itself complete.
        let ctx = answering_ctx(mirror_with_tracks(4_294_967_301)).await;
        let r = execute(&ctx, "get_device_chains", &json!({})).await;

        let reason = r.missing_reason.clone().unwrap_or_default();
        assert!(reason.contains("4294967301"), "{reason}");
        let tracks = r.value["tracks"].as_array().unwrap();
        let missing = r.value["missing"].as_array().unwrap();
        assert_eq!(tracks.len() + missing.len(), 512, "the count wrapped instead of clamping");
    }

    #[test]
    fn a_track_count_past_i32_still_finishes_the_identity_bracket() {
        // The clamp bounds the two identity brackets as well as the fan-out,
        // and those brackets are SYNCHRONOUS loops over `0..read_tracks`.
        // Move the clamp below them and the loops run over ~4.29e9 indices;
        // the test above would then hang instead of failing, and a hang is
        // a regression nobody reads as one.
        //
        // Asserting on it needs no bracket length exposed from production
        // code -- run the call under a deadline instead. Three details make
        // that report a failure rather than reproduce the hang:
        //   - multi_thread, so the deadline's timer runs on a worker the
        //     synchronous loop is not occupying;
        //   - `tokio::spawn`, so the loop is on a task the deadline can
        //     stop waiting on;
        //   - `shutdown_background`, because dropping a runtime waits for
        //     its tasks, and a task inside a synchronous loop never yields
        //     -- a normal drop would hang the binary after the assertion
        //     failed but before libtest printed it.
        // The clamped path finishes in ~0.02 s against a 5 s deadline.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let finished = rt.block_on(async {
            let ctx = answering_ctx(mirror_with_tracks(4_294_967_301)).await;
            let call =
                tokio::spawn(async move { execute(&ctx, "get_device_chains", &json!({})).await });
            tokio::time::timeout(std::time::Duration::from_secs(5), call).await
        });
        rt.shutdown_background();

        let r = finished
            .expect("the identity bracket ran unclamped over the raw mirrored count")
            .unwrap();
        assert!(r.missing_reason.unwrap_or_default().contains("4294967301"));
    }

    #[tokio::test]
    async fn get_device_params_refuses_a_missing_device_index() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_device_params", &json!({ "track": 0 })).await;
        assert_eq!(r.missing_reason.as_deref(), Some("bad_arguments"));
    }

    #[tokio::test]
    async fn get_device_params_refuses_a_negative_index() {
        // A negative path element is refused before it reaches the wire:
        // Python slices from the END on one, so it would resolve inside
        // Live to a real but different device rather than naming none.
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_device_params", &json!({ "track": 0, "path": [-1] })).await;
        assert_eq!(result.missing_reason.as_deref(), Some("bad_arguments"));
    }

    #[test]
    fn the_schema_lists_exactly_the_five_tools_the_model_may_call() {
        let schema = tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "get_track_detail",
                "get_clip_notes",
                "get_device_chains",
                "get_device_params",
                "get_rack_contents"
            ]
        );
        // Every entry must be a well-formed OpenAI function tool, or a
        // provider rejects the whole request with a 400 that reads like a
        // model problem.
        for t in schema.as_array().unwrap() {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["description"].is_string());
            assert_eq!(t["function"]["parameters"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn a_mirror_read_reports_an_age_that_is_older_than_its_query_time() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 0 })).await;
        assert_eq!(result.missing_reason, None);
        assert!(result.fresh);
        assert_eq!(result.value["name"], "«Bass»");
        let fresh_as_of = result.fresh_as_of.expect("a mirror read must report an age");
        assert!(fresh_as_of <= result.queried_at);
    }

    #[tokio::test]
    async fn a_track_the_mirror_has_never_seen_reports_a_reason_and_no_value() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 9 })).await;
        assert_eq!(result.value, serde_json::Value::Null);
        assert_eq!(result.missing_reason.as_deref(), Some("not_in_mirror"));
        assert!(!result.fresh);
    }

    #[tokio::test]
    async fn a_live_query_before_the_socket_binds_says_so_rather_than_hanging() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(
            &ctx,
            "get_clip_notes",
            &serde_json::json!({ "track": 0, "clip": 0 }),
        )
        .await;
        assert_eq!(result.missing_reason.as_deref(), Some("not_connected"));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_reported_not_silently_empty() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(&ctx, "delete_everything", &serde_json::json!({})).await;
        assert_eq!(result.missing_reason.as_deref(), Some("unknown_tool"));
        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn int_arg_accepts_an_integral_float_but_rejects_a_fractional_one() {
        // Real providers commonly emit floats for integer fields.
        assert_eq!(int_arg(&serde_json::json!({ "track": 1.0 }), "track"), Some(1));
        assert_eq!(int_arg(&serde_json::json!({ "track": -2.0 }), "track"), Some(-2));
        assert_eq!(int_arg(&serde_json::json!({ "track": 1.5 }), "track"), None);
        assert_eq!(int_arg(&serde_json::json!({ "track": 3 }), "track"), Some(3));
    }

    #[test]
    fn track_identity_reads_the_mirrored_name() {
        let coalescer = Mutex::new(one_track_mirror());
        assert_eq!(track_identity(&coalescer, 0), Some(serde_json::json!("Bass")));
        assert_eq!(track_identity(&coalescer, 4), None);
    }

    #[test]
    fn topology_moved_reports_a_rename_a_reorder_and_a_delete() {
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        // A reorder shows up here exactly as a rename does: a different name
        // now sits at the index the query was keyed on. That is the case a
        // generation counter driven by num_tracks would miss entirely.
        assert!(topology_moved(&bass, &kick));
        // The track fell out of the mirror: deleted.
        assert!(topology_moved(&bass, &None));
        assert!(!topology_moved(&bass, &bass));
    }

    #[test]
    fn topology_moved_abstains_when_the_mirror_never_held_the_track() {
        // No baseline means no comparison. Reporting a change here would
        // invent a warning, which is the same class of error as inventing a
        // value.
        assert!(!topology_moved(&None, &Some(serde_json::json!("Bass"))));
        assert!(!topology_moved(&None, &None));
    }

    #[test]
    fn track_count_reads_the_mirrored_count_with_no_key_args() {
        // num_tracks is KeyArity::None, so the mirror holds it with no key
        // args and the count is args[0]. If this ever drifts, every reader
        // of track_count silently degrades to not_in_mirror.
        let coalescer = Mutex::new(mirror_with_tracks(8));
        assert_eq!(track_count(&coalescer), Some(8));
        assert_eq!(track_count(&Mutex::new(Coalescer::new())), None);
    }

    #[test]
    fn chains_moved_catches_a_same_count_reorder_a_count_check_alone_would_miss() {
        // This is the bug the count-only guard had: an add or delete changes
        // num_tracks, but a reorder does not. Two tracks swapping places
        // leaves the count identical while every downstream index now names
        // a different track's devices.
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        let before = vec![bass.clone(), kick.clone()];
        let reordered = vec![kick, bass];
        assert!(chains_moved(2, Some(2), &before, &reordered));
    }

    #[test]
    fn chains_moved_reports_an_added_or_deleted_track() {
        let bass = Some(serde_json::json!("Bass"));
        let before = vec![bass.clone()];
        assert!(chains_moved(1, Some(2), &before, &[bass.clone(), None]));
        assert!(chains_moved(1, Some(0), &before, &[]));
    }

    #[test]
    fn chains_moved_abstains_on_a_stable_set() {
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        let names = vec![bass, kick];
        assert!(!chains_moved(2, Some(2), &names, &names));
    }

    #[test]
    fn rack_payload_omits_what_was_never_observed_rather_than_nulling_it() {
        // A window-0 decode failure observes NOTHING about the device's
        // structure. An explicit `"is_rack": null` still invites the model to
        // read something into the field, and the tool description tells it
        // this field distinguishes "not a Rack" from "an empty Rack" -- so the
        // key has to be absent, not present-and-empty.
        let unobserved = rack_contents::RackContents {
            chains: vec![],
            total_chains: None,
            is_rack: None,
            truncated: false,
            missing_reason: Some("malformed_reply".to_string()),
        };
        let payload = rack_payload(&unobserved);
        assert!(payload.get("is_rack").is_none(), "is_rack must be absent, not null");
        assert!(payload.get("total_chains").is_none());
        assert_eq!(payload["chains"], json!([]));
    }

    #[test]
    fn rack_payload_carries_an_empty_rack_as_a_real_observation() {
        // The mirror image, and the reason the two must stay distinguishable:
        // "this Rack has nothing loaded in it" is a real thing to know about a
        // set, and it is reported with the fields present.
        let empty_rack = rack_contents::RackContents {
            chains: vec![],
            total_chains: Some(0),
            is_rack: Some(true),
            truncated: false,
            missing_reason: None,
        };
        let payload = rack_payload(&empty_rack);
        assert_eq!(payload["is_rack"], json!(true));
        assert_eq!(payload["total_chains"], json!(0));
    }

    #[test]
    fn chain_map_reasons_is_none_on_a_clean_read() {
        assert_eq!(chain_map_reasons(4, 4, &[], &[]), None);
    }

    #[test]
    fn chain_map_reasons_names_a_truncated_fan_out_alone() {
        let reason = chain_map_reasons(600, 512, &[], &[]).unwrap();
        assert_eq!(reason, "truncated_to_first_512_tracks: the set has 600");
    }

    #[test]
    fn chain_map_reasons_names_tracks_that_did_not_answer_at_all_alone() {
        let reason = chain_map_reasons(4, 4, &[1, 3], &[]).unwrap();
        assert_eq!(reason, "no_reply_for_tracks: 1, 3");
    }

    #[test]
    fn chain_map_reasons_names_tracks_missing_only_their_rack_marks_alone() {
        // The devices ARE listed for these tracks; only which of them are
        // Racks is unknown. A reader who took this as "these tracks failed"
        // would discard a chain map that is present and correct.
        let reason = chain_map_reasons(4, 4, &[], &[2]).unwrap();
        assert_eq!(
            reason,
            "rack_marks_unavailable_for_tracks: 2 (their devices are listed, but which are Racks is unknown)"
        );
    }

    #[test]
    fn chain_map_reasons_joins_all_three_when_all_three_hold() {
        // All three can hold at once, and none may overwrite another.
        let reason = chain_map_reasons(600, 512, &[1], &[2]).unwrap();
        assert_eq!(
            reason,
            "truncated_to_first_512_tracks: the set has 600; \
no_reply_for_tracks: 1; \
rack_marks_unavailable_for_tracks: 2 (their devices are listed, but which are Racks is unknown)"
        );
    }

    #[tokio::test]
    async fn a_missing_or_wrongly_typed_argument_is_reported_not_defaulted() {
        // Defaulting a missing track index to 0 would answer a question the
        // model did not ask, about a track it did not name.
        let ctx = disconnected_ctx(one_track_mirror());
        for args in [serde_json::json!({}), serde_json::json!({ "track": "bass" })] {
            let result = execute(&ctx, "get_track_detail", &args).await;
            assert_eq!(result.missing_reason.as_deref(), Some("bad_arguments"));
        }
    }
}
