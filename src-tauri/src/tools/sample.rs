//! get_sample's read: one audio clip or Simpler, its file, settings and the
//! region Live plays, mapped to frames inside Live. The reply layout is
//! `mixingpal/sample_replies.py`'s.

use crate::analysis::cache::{Job, ANALYSES};
use crate::analysis::levels::Tail;
use crate::analysis::pitch::{self, Pitch};
use crate::analysis::spectrum::BANDS;
use crate::analysis::{Stat, Stats};
use serde_json::{Map, Value};
use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::clip_notes::LoopRegion;
use crate::tools::fence::fence;
use crate::tools::path::DevicePath;
use rosc::OscType;
use serde_json::json;
use std::fmt;
use std::time::Duration;

pub const ADDRESS: &str = "/live/mixingpal/get/sample";

/// Equal to `rack_contents::QUERY_TIMEOUT`: one round trip, no paging.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

pub const FRAMES_ADDRESS: &str = "/live/mixingpal/get/sample/frames";

/// The frames address's statuses, as fixed strings.
const FRAME_STATUSES: [&str; 5] = ["not_audio_clip", "empty_slot", "no_such_target", "not_warped", "bad_beats"];

/// Every analysis block opens with this.
pub const ABOUT: &str = "These stats describe the file's region before clip gain, warping, devices and the fader.";
/// One analysis, from when it gets one of the two slots. A debug build runs
/// it about 80 times slower, so `tauri dev` gets longer.
pub const ANALYSIS_BUDGET: Duration = Duration::from_secs(if cfg!(debug_assertions) { 120 } else { 8 });
/// The most a call waits for a slot, behind other calls of the same turn.
pub const ANALYSIS_WAIT: Duration = Duration::from_secs(30);
const PROFILE_MIN_SECONDS: f64 = 2.0;
const SEGMENT_SECONDS: f64 = 0.5;
const MAX_SEGMENTS: f64 = 64.0;
const MAX_POSITIONS: usize = 65;

/// Settings fields between the status and the interval count.
const SETTINGS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub enum SampleTarget {
    Slot(i32),
    Index(i32),
    Device(DevicePath),
}

impl SampleTarget {
    pub fn kind(&self) -> i32 {
        match self {
            SampleTarget::Slot(_) => 0,
            SampleTarget::Index(_) => 1,
            SampleTarget::Device(_) => 2,
        }
    }

    /// Always a string, so the request keys on Args(3) whatever the kind.
    pub fn wire(&self) -> String {
        match self {
            SampleTarget::Slot(i) | SampleTarget::Index(i) => i.to_string(),
            SampleTarget::Device(path) => path.wire(),
        }
    }
}

/// The sample file's full path. It is not `Serialize` and its `Debug` hides
/// it, so it cannot reach a tool result, a trace, or the proxy. The analysis
/// opens the file through as_path.
pub struct SourcePath(pub(crate) String);

impl SourcePath {
    /// The file name alone, cut on either separator before any fencing.
    pub fn file_name(&self) -> &str {
        self.0.rsplit(['/', '\\']).next().unwrap_or("")
    }

    /// For opening the file. Never for a result: see the type's doc.
    pub(crate) fn as_path(&self) -> &std::path::Path {
        std::path::Path::new(&self.0)
    }
}

impl fmt::Debug for SourcePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SourcePath(..)")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Interval {
    /// Source units: beats when warped, seconds when not, frames on a Simpler.
    pub source: (f64, f64),
    pub frames: (f64, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClipTiming {
    pub looping: Option<bool>,
    pub muted: Option<bool>,
    pub start_marker: Option<f64>,
    pub loop_start: Option<f64>,
    pub loop_end: Option<f64>,
    /// Song beats, arrangement clips only.
    pub placement: Option<(f64, f64)>,
    pub tempo: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimplerSettings {
    pub mode: Option<i32>,
    pub slices: Option<i32>,
    pub loop_frames: Option<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Holder {
    Clip(ClipTiming),
    Simpler(SimplerSettings),
}

#[derive(Debug)]
pub struct SampleRead {
    /// `None` when Live could not read it; the other settings still stand.
    pub path: Option<SourcePath>,
    pub sample_rate: Option<f64>,
    pub length_frames: Option<f64>,
    pub warping: Option<bool>,
    pub warp_mode: Option<i32>,
    pub gain: Option<String>,
    pub transpose: Option<f64>,
    pub detune: Option<f64>,
    /// Empty when Live could not give the region: `region_unavailable`.
    pub intervals: Vec<Interval>,
    pub holder: Holder,
}

#[derive(Debug)]
pub enum SampleError {
    /// A named status from the connector, as a fixed string.
    Refused(&'static str),
    Malformed,
    Query(QueryError),
}

/// The connector's statuses. Mapping to fixed strings keeps any text from
/// Live, a path above all, out of a missing reason.
const STATUSES: [&str; 8] = [
    "not_audio_clip", "empty_slot", "no_such_target", "not_a_simpler",
    "no_sample", "multisample_not_readable", "sampler_not_readable", "path_too_long",
];

/// A number or nil. `Err` for any other type: the record is misaligned.
fn number(v: Option<&OscType>) -> Result<Option<f64>, SampleError> {
    match v {
        Some(OscType::Float(x)) => Ok(Some(f64::from(*x))),
        Some(OscType::Double(x)) => Ok(Some(*x)),
        Some(OscType::Int(x)) => Ok(Some(f64::from(*x))),
        Some(OscType::Long(x)) => Ok(Some(*x as f64)),
        Some(OscType::Nil) => Ok(None),
        _ => Err(SampleError::Malformed),
    }
}

fn int(v: Option<&OscType>) -> Result<Option<i32>, SampleError> {
    match v {
        Some(OscType::Int(x)) => Ok(Some(*x)),
        Some(OscType::Nil) => Ok(None),
        _ => Err(SampleError::Malformed),
    }
}

fn boolean(v: Option<&OscType>) -> Result<Option<bool>, SampleError> {
    match v {
        Some(OscType::Bool(x)) => Ok(Some(*x)),
        Some(OscType::Nil) => Ok(None),
        _ => Err(SampleError::Malformed),
    }
}

fn string(v: Option<&OscType>) -> Result<Option<String>, SampleError> {
    match v {
        Some(OscType::String(s)) => Ok(Some(s.clone())),
        Some(OscType::Nil) => Ok(None),
        _ => Err(SampleError::Malformed),
    }
}

fn pair(a: Option<f64>, b: Option<f64>) -> Option<(f64, f64)> {
    a.zip(b)
}

pub fn decode_reply(reply: &[OscType], track: i32, target: &SampleTarget) -> Result<SampleRead, SampleError> {
    let wire = target.wire();
    match reply {
        [OscType::Int(t), OscType::Int(k), OscType::String(w), ..] if *t == track && *k == target.kind() && *w == wire => {}
        _ => return Err(SampleError::Malformed),
    }
    let status = string(reply.get(3))?.ok_or(SampleError::Malformed)?;
    if status != "ok" {
        return Err(STATUSES.into_iter().find(|s| *s == status).map_or(SampleError::Malformed, SampleError::Refused));
    }
    let at = |i: usize| reply.get(4 + i);
    let path = string(at(0))?.map(SourcePath);
    let count = int(at(SETTINGS))?.ok_or(SampleError::Malformed)?;
    let count = usize::try_from(count).map_err(|_| SampleError::Malformed)?;
    // A clip plays at most two stretches, a Simpler one. Checked before any
    // allocation, so a bad count cannot ask for gigabytes.
    if count > if target.kind() == 2 { 1 } else { 2 } {
        return Err(SampleError::Malformed);
    }
    let first = 4 + SETTINGS + 1;
    let extra = first + 4 * count;
    let mut intervals = Vec::with_capacity(count);
    for i in 0..count {
        let n = |j: usize| number(reply.get(first + 4 * i + j));
        let (Some(a), Some(b), Some(fa), Some(fb)) = (n(0)?, n(1)?, n(2)?, n(3)?) else {
            return Err(SampleError::Malformed);
        };
        // Python never sends these; a reply that does is not trusted.
        if ![a, b, fa, fb].iter().all(|x| x.is_finite()) || fb <= fa {
            return Err(SampleError::Malformed);
        }
        intervals.push(Interval { source: (a, b), frames: (fa, fb) });
    }
    let e = |i: usize| reply.get(extra + i);
    let holder = if target.kind() == 2 {
        if reply.len() != extra + 4 {
            return Err(SampleError::Malformed);
        }
        Holder::Simpler(SimplerSettings {
            mode: int(e(0))?,
            slices: int(e(1))?,
            loop_frames: pair(number(e(2))?, number(e(3))?),
        })
    } else {
        if reply.len() != extra + 8 {
            return Err(SampleError::Malformed);
        }
        Holder::Clip(ClipTiming {
            looping: boolean(e(0))?,
            muted: boolean(e(1))?,
            start_marker: number(e(2))?,
            loop_start: number(e(3))?,
            loop_end: number(e(4))?,
            placement: pair(number(e(5))?, number(e(6))?),
            tempo: number(e(7))?,
        })
    };
    Ok(SampleRead {
        path,
        sample_rate: number(at(1))?,
        length_frames: number(at(2))?,
        warping: boolean(at(3))?,
        warp_mode: int(at(4))?,
        gain: string(at(5))?,
        transpose: number(at(6))?,
        detune: number(at(7))?,
        intervals,
        holder,
    })
}

pub async fn get_sample(q: &LiveQuery, track: i32, target: &SampleTarget, timeout: Duration) -> Result<SampleRead, SampleError> {
    let args = vec![OscType::Int(track), OscType::Int(target.kind()), OscType::String(target.wire())];
    let reply = q.query(ADDRESS, args, timeout).await.map_err(SampleError::Query)?;
    decode_reply(&reply, track, target)
}

/// Beat positions on the wire: one string, so the request keys on Args(4)
/// whatever the count. Rounded to a millionth so the echo stays short.
pub fn beats_wire(beats: &[f64]) -> String {
    beats.iter().map(|b| format!("{}", (b * 1e6).round() / 1e6)).collect::<Vec<_>>().join(",")
}

pub fn decode_frames_reply(reply: &[OscType], track: i32, target: &SampleTarget, beats: &str, count: usize) -> Result<Vec<Option<f64>>, SampleError> {
    let wire = target.wire();
    match reply {
        [OscType::Int(t), OscType::Int(k), OscType::String(w), OscType::String(b), ..]
            if *t == track && *k == target.kind() && *w == wire && b == beats => {}
        _ => return Err(SampleError::Malformed),
    }
    let status = string(reply.get(4))?.ok_or(SampleError::Malformed)?;
    if status != "ok" {
        return Err(FRAME_STATUSES.into_iter().find(|s| *s == status).map_or(SampleError::Malformed, SampleError::Refused));
    }
    let n = int(reply.get(5))?.ok_or(SampleError::Malformed)?;
    if usize::try_from(n).ok() != Some(count) || reply.len() != 6 + count {
        return Err(SampleError::Malformed);
    }
    reply[6..].iter().map(|v| number(Some(v))).collect()
}

/// Live's frame for each beat of a warped clip: what the profile cuts on.
pub async fn get_sample_frames(q: &LiveQuery, track: i32, target: &SampleTarget, beats: &[f64], timeout: Duration) -> Result<Vec<Option<f64>>, SampleError> {
    let wire = beats_wire(beats);
    let args = vec![OscType::Int(track), OscType::Int(target.kind()), OscType::String(target.wire()), OscType::String(wire.clone())];
    let reply = q.query(FRAMES_ADDRESS, args, timeout).await.map_err(SampleError::Query)?;
    decode_frames_reply(&reply, track, target, &wire, beats.len())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub beat: Option<f64>,
    /// Seconds of the file where the segment starts.
    pub at_s: f64,
    /// The segment's frames in the decoded stream, which plays the region's
    /// intervals back to back.
    pub stream: (u64, u64),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Profile {
    Off,
    Unavailable(&'static str),
    Segments(Vec<Segment>),
}

/// Each interval's frames as whole numbers, in playback order.
pub fn region_frames(read: &SampleRead) -> Vec<(u64, u64)> {
    read.intervals.iter().map(|i| (i.frames.0.max(0.0).round() as u64, i.frames.1.max(0.0).round() as u64)).collect()
}

/// Where each interval starts in the decoded stream.
fn stream_offsets(frames: &[(u64, u64)]) -> Vec<u64> {
    frames
        .iter()
        .scan(0u64, |at, (a, b)| {
            let start = *at;
            *at += b.saturating_sub(*a);
            Some(start)
        })
        .collect()
}

/// Half-second segments, lengthened to a whole multiple of 0.5 s when there
/// would be more than 64, and cut where one interval ends and the next begins.
pub fn time_segments(read: &SampleRead, rate: f64) -> Vec<Segment> {
    let frames = region_frames(read);
    let total: u64 = frames.iter().map(|(a, b)| b.saturating_sub(*a)).sum();
    let count = (total as f64 / (SEGMENT_SECONDS * rate)).ceil();
    let length = ((SEGMENT_SECONDS * rate * (count / MAX_SEGMENTS).ceil().max(1.0)).round() as u64).max(1);
    let mut out = Vec::new();
    for ((a, b), offset) in frames.iter().zip(stream_offsets(&frames)) {
        let mut s = *a;
        while s < *b {
            let e = (s + length).min(*b);
            out.push(Segment { beat: None, at_s: s as f64 / rate, stream: (offset + s - a, offset + e - a) });
            s = e;
        }
    }
    out
}

/// Each interval's ends and the beats between, every `stride` beats, the
/// stride doubled until every position fits in one request.
pub fn beat_positions(intervals: &[Interval]) -> Vec<Vec<f64>> {
    let mut stride = 1.0f64;
    loop {
        let positions: Vec<Vec<f64>> = intervals
            .iter()
            .map(|i| {
                let (a, b) = i.source;
                let mut p = vec![a];
                let mut k = (a / stride).floor() + 1.0;
                while k * stride < b - 1e-9 {
                    p.push(k * stride);
                    k += 1.0;
                }
                p.push(b);
                p
            })
            .collect();
        if positions.iter().map(Vec::len).sum::<usize>() <= MAX_POSITIONS {
            return positions;
        }
        stride *= 2.0;
    }
}

/// Segments between consecutive beat positions, on the frames Live mapped
/// them to. None when Live could not map one.
pub fn beat_segments(read: &SampleRead, positions: &[Vec<f64>], frames: &[Option<f64>], rate: f64) -> Option<Vec<Segment>> {
    let region = region_frames(read);
    let mut mapped = frames.iter();
    let mut out = Vec::new();
    for ((beats, (a, b)), offset) in positions.iter().zip(&region).zip(stream_offsets(&region)) {
        let at: Vec<u64> = beats
            .iter()
            .map(|_| mapped.next().copied().flatten().map(|f| f.round().clamp(*a as f64, *b as f64) as u64))
            .collect::<Option<_>>()?;
        for j in 0..at.len().saturating_sub(1) {
            if at[j + 1] > at[j] {
                out.push(Segment { beat: Some(beats[j]), at_s: at[j] as f64 / rate, stream: (offset + at[j] - a, offset + at[j + 1] - a) });
            }
        }
    }
    Some(out)
}

/// What the profile cuts on: beats for a warped clip, mapped by Live, half
/// seconds for anything else.
pub async fn plan_profile(q: &LiveQuery, track: i32, target: &SampleTarget, read: &SampleRead) -> Profile {
    let Some(rate) = read.sample_rate.filter(|r| *r > 0.0) else {
        return Profile::Unavailable("region_unavailable");
    };
    if read.intervals.is_empty() {
        return Profile::Unavailable("region_unavailable");
    }
    let total: u64 = region_frames(read).iter().map(|(a, b)| b.saturating_sub(*a)).sum();
    if (total as f64) < PROFILE_MIN_SECONDS * rate {
        return Profile::Unavailable("region_too_short");
    }
    if !(matches!(read.holder, Holder::Clip(_)) && read.warping == Some(true)) {
        return Profile::Segments(time_segments(read, rate));
    }
    let positions = beat_positions(&read.intervals);
    match get_sample_frames(q, track, target, &positions.concat(), QUERY_TIMEOUT).await {
        Ok(frames) => beat_segments(read, &positions, &frames, rate).map_or(Profile::Unavailable("profile_unavailable"), Profile::Segments),
        Err(_) => Profile::Unavailable("profile_unavailable"),
    }
}

/// Runs, or reuses, the analysis of the played region. None when there is
/// no region, which the result already names. Also the channel count.
pub async fn analysis_block(read: &SampleRead, profile: &Profile) -> Option<(Value, Option<usize>)> {
    let regions = region_frames(read);
    if regions.is_empty() || read.sample_rate.filter(|r| *r > 0.0).is_none() {
        return None;
    }
    let failed = |code: &str| json!({ "about": ABOUT, "missing_reason": code });
    let Some(path) = read.path.as_ref() else {
        return Some((failed("file_missing"), None));
    };
    let segments = match profile {
        Profile::Segments(s) => Some(s.iter().map(|s| s.stream).collect()),
        _ => None,
    };
    let job = Job { path: path.as_path().to_path_buf(), regions, segments };
    Some(match ANALYSES.get(job, std::time::Instant::now() + ANALYSIS_WAIT, ANALYSIS_BUDGET).await {
        Ok(stats) => (analysis_payload(&stats, read, profile), Some(stats.channels)),
        Err(e) => (failed(e.code()), None),
    })
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn r10(x: f64) -> f64 {
    (x / 10.0).round() * 10.0
}

fn whole(x: f64) -> f64 {
    x.round()
}

/// An analysis block's fields, each null's reason gathered beside them.
#[derive(Default)]
struct Block {
    fields: Map<String, Value>,
    why: Map<String, Value>,
}

impl Block {
    fn put(&mut self, key: &str, value: Value) {
        self.fields.insert(key.into(), value);
    }

    fn null(&mut self, key: &str, reason: &str) {
        self.fields.insert(key.into(), Value::Null);
        self.why.insert(key.into(), json!(reason));
    }

    fn value(&mut self, key: &str, stat: Stat, round: fn(f64) -> f64) -> Value {
        match stat {
            Ok(v) => json!(round(v)),
            Err(reason) => {
                self.why.insert(key.into(), json!(reason));
                Value::Null
            }
        }
    }

    fn set(&mut self, key: &str, stat: Stat, round: fn(f64) -> f64) {
        let v = self.value(key, stat, round);
        self.put(key, v);
    }
}

fn pitch_json(hz: f64) -> Value {
    let (note, cents) = pitch::note(hz);
    json!({ "note": note, "hz": r1(hz), "cents": cents })
}

fn pitch_value(p: &Pitch, shift: impl Fn(f64) -> f64) -> Result<Value, &'static str> {
    match p {
        Pitch::Steady(hz) => Ok(pitch_json(shift(*hz))),
        Pitch::Sweep { from_hz, tail_hz } => Ok(json!({ "sweep_hz": [r1(shift(*from_hz)), r1(shift(*tail_hz))], "tail": pitch_json(shift(*tail_hz)) })),
        Pitch::Unknown(reason) => Err(reason),
    }
}

/// The analysis the model reads. Pitch after transpose is computed here, at
/// each call, from the cached raw pitch and the clip's current settings.
pub fn analysis_payload(stats: &Stats, read: &SampleRead, profile: &Profile) -> Value {
    let mut b = Block::default();
    let l = &stats.levels;
    b.put("about", json!(ABOUT));
    b.put("seconds", json!(r2(stats.seconds)));
    let peaks: Vec<Value> = l.sample_peak_dbfs.iter().map(|p| b.value("sample_peak_dbfs", *p, r1)).collect();
    b.put("sample_peak_dbfs", json!(peaks));
    b.set("true_peak_dbfs", l.true_peak_dbfs, r1);
    b.put("full_scale_samples", json!(l.full_scale_samples));
    b.set("rms_dbfs", l.rms_dbfs, r1);
    b.set("crest_db", l.crest_db, r1);
    b.put("silent_share", json!(r2(l.silent_share)));
    match stats.spectrum.band_shares {
        Ok(shares) => b.put("band_shares", Value::Object(BANDS.iter().zip(shares).map(|((name, _), s)| (name.to_string(), json!(r2(s)))).collect())),
        Err(reason) => b.null("band_shares", reason),
    }
    b.set("centroid_hz", stats.spectrum.centroid_hz, whole);
    match &stats.stereo {
        Ok(s) => {
            let mut inner = Block::default();
            inner.set("correlation", s.correlation, r2);
            inner.set("side_to_mid_db", s.side_to_mid_db, r1);
            inner.set("below_150_hz_correlation", s.low_correlation, r2);
            inner.set("below_150_hz_side_to_mid_db", s.low_side_to_mid_db, r1);
            for (k, v) in inner.why {
                b.why.insert(format!("stereo.{k}"), v);
            }
            b.put("stereo", Value::Object(inner.fields));
        }
        Err(reason) => b.null("stereo", reason),
    }
    match pitch_value(&stats.pitch, |hz| hz) {
        Ok(v) => b.put("pitch", v),
        Err(reason) => b.null("pitch", reason),
    }
    // Re-Pitch ties the pitch to the tempo, so no transpose names it.
    let after = match (read.warping == Some(true) && read.warp_mode == Some(3), read.transpose) {
        (true, _) => Err("re_pitch"),
        (false, None) => Err("transpose_unreadable"),
        (false, Some(t)) => pitch_value(&stats.pitch, |hz| pitch::transposed(hz, t, read.detune.unwrap_or(0.0))),
    };
    match after {
        Ok(v) => b.put("pitch_after_transpose", v),
        Err(reason) => b.null("pitch_after_transpose", reason),
    }
    b.set("onsets_per_second", stats.onsets_per_second, r1);
    b.set("leading_silence_ms", l.leading_silence_ms, whole);
    if let Some(a) = l.attack_ms {
        b.put("attack_ms", json!(a));
    }
    match l.tail {
        Some(Tail::Ms(ms)) => b.put("tail_ms", json!(ms)),
        Some(Tail::AtLeast(ms)) => b.put("tail_ms_at_least", json!(ms)),
        None => {}
    }
    // Past 50 ms short, the stats cover less than the region, and the
    // profile's later segments would be shifted or read as silence.
    let short = stats.missing_frames * 20 > u64::from(stats.rate);
    if short {
        b.put("file_short_by_s", json!(r2(stats.missing_frames as f64 / f64::from(stats.rate))));
    }
    match profile {
        Profile::Off => {}
        Profile::Segments(_) if short => b.null("profile", "file_shorter_than_region"),
        Profile::Unavailable(reason) => b.null("profile", reason),
        Profile::Segments(segments) => b.put("profile", profile_columns(stats, segments)),
    }
    if !b.why.is_empty() {
        let why = std::mem::take(&mut b.why);
        b.put("null_because", Value::Object(why));
    }
    Value::Object(b.fields)
}

/// Columns, not one object per segment: 64 objects would cost about 4.5 KB.
/// A null value is a silent segment.
fn profile_columns(stats: &Stats, segments: &[Segment]) -> Value {
    let column = |values: &[Stat], round: fn(f64) -> f64| -> Vec<Value> {
        values.iter().map(|v| match v { Ok(x) => json!(round(*x)), Err(_) => Value::Null }).collect()
    };
    let mut p = json!({
        "at_s": segments.iter().map(|s| r2(s.at_s)).collect::<Vec<_>>(),
        "rms_dbfs": column(&stats.levels.segment_rms_dbfs, r1),
        "centroid_hz": column(&stats.spectrum.segment_centroid_hz, r10),
    });
    if !segments.is_empty() && segments.iter().all(|s| s.beat.is_some()) {
        p["beat"] = json!(segments.iter().map(|s| s.beat).collect::<Vec<_>>());
    }
    p
}
/// Live's `Clip.warp_mode` numbers. 5 is REX; 7 is not used.
pub fn warp_name(mode: i32) -> &'static str {
    match mode {
        0 => "Beats",
        1 => "Tones",
        2 => "Texture",
        3 => "Re-Pitch",
        4 => "Complex",
        5 => "REX",
        6 => "Complex Pro",
        _ => "unknown",
    }
}

fn simpler_mode(mode: i32) -> &'static str {
    match mode {
        0 => "Classic",
        1 => "One-Shot",
        2 => "Slice",
        _ => "unknown",
    }
}

fn seconds(frames: f64, rate: f64) -> f64 {
    (frames / rate * 1000.0).round() / 1000.0
}

fn ranges(intervals: &[Interval], rate: f64) -> String {
    let each: Vec<_> = intervals
        .iter()
        .map(|i| format!("{:.2}-{:.2} s", i.frames.0 / rate, i.frames.1 / rate))
        .collect();
    format!("{} of the file", each.join(" then "))
}

/// The result the model reads. The path stays in `read`; only its file name
/// is copied here.
pub fn sample_payload(read: &SampleRead, kind: i32, signature: Option<(i64, i64)>) -> (serde_json::Value, Option<&'static str>) {
    let source = match (kind, &read.holder) {
        (_, Holder::Simpler(_)) => "simpler",
        (1, _) => "arrangement_clip",
        _ => "session_clip",
    };
    let mut p = json!({
        "source": source,
        "file": read.path.as_ref().map(|p| fence(p.file_name())),
        "sample_rate": read.sample_rate,
        "warp": match (read.warping, read.warp_mode) {
            (Some(true), Some(m)) => json!(warp_name(m)),
            (Some(false), _) => json!(false),
            _ => json!(null),
        },
        "gain": read.gain,
        "transpose_semitones": read.transpose,
        "detune_cents": read.detune,
    });
    if let (Some(frames), Some(rate)) = (read.length_frames, read.sample_rate.filter(|r| *r > 0.0)) {
        p["file_seconds"] = json!(seconds(frames, rate));
    }
    let rate = read.sample_rate.filter(|r| *r > 0.0);
    let missing = (read.intervals.is_empty() || rate.is_none()).then_some("region_unavailable");
    match &read.holder {
        Holder::Clip(t) => {
            if t.muted == Some(true) {
                p["muted"] = json!(true);
            }
            if let Some((start, end)) = t.placement {
                p["start_beats"] = json!(start);
                p["length_beats"] = json!(end - start);
                super::add_bar_timing(&mut p, start, end - start, signature);
            }
            if let (Some(rate), None) = (rate, missing) {
                p["region"] = json!({
                    "intervals_seconds": read.intervals.iter().map(|i| [seconds(i.frames.0, rate), seconds(i.frames.1, rate)]).collect::<Vec<_>>(),
                    "plays": clip_words(read, t, rate, signature),
                });
            }
        }
        Holder::Simpler(s) => {
            let mode = s.mode.map(simpler_mode);
            p["mode"] = json!(mode);
            if mode == Some("Slice") {
                p["slices"] = json!(s.slices);
            } else if matches!(mode, Some("Classic" | "One-Shot")) {
                p["pitch"] = json!("pitch follows the MIDI note: C3 plays the sample at its original pitch plus Transpose and Detune");
            }
            if let (Some(rate), None) = (rate, missing) {
                let what = ranges(&read.intervals, rate);
                let plays = match (mode, s.loop_frames) {
                    (Some("Slice"), _) => format!("slices are cut from {what}"),
                    (_, Some((a, b))) => format!("a note plays {what}; held, it loops {:.2}-{:.2} s", a / rate, b / rate),
                    _ => format!("a note plays {what}"),
                };
                p["region"] = json!({
                    "intervals_seconds": read.intervals.iter().map(|i| [seconds(i.frames.0, rate), seconds(i.frames.1, rate)]).collect::<Vec<_>>(),
                    "plays": plays,
                });
            }
        }
    }
    (p, missing)
}

/// "plays 0.00-2.00 s of the file, bars 39-42, a 1-bar loop played 4 times".
fn clip_words(read: &SampleRead, t: &ClipTiming, rate: f64, signature: Option<(i64, i64)>) -> String {
    let what = ranges(&read.intervals, rate);
    let Some((start, end)) = t.placement else {
        return match (t.looping, read.intervals.as_slice()) {
            (Some(true), [intro, looped]) => format!(
                "plays {:.2}-{:.2} s of the file once, then loops {:.2}-{:.2} s when launched",
                intro.frames.0 / rate, intro.frames.1 / rate, looped.frames.0 / rate, looped.frames.1 / rate,
            ),
            (Some(true), _) => format!("loops {what} when launched"),
            _ => format!("plays {what} when launched"),
        };
    };
    let length = end - start;
    let Some(beats_per_bar) = signature.and_then(super::beats_per_bar) else {
        return format!("plays {what}");
    };
    let span = super::bar_span(start, length, beats_per_bar);
    // An unwarped clip's markers are seconds, so what it plays follows the
    // current tempo, looped or not, and the words say so. Pass counting runs
    // in song beats.
    let (scale, tempo_note) = match (read.warping, t.tempo) {
        (Some(true), _) => (1.0, String::new()),
        (Some(false), Some(tempo)) if tempo > 0.0 => (tempo / 60.0, format!(", at the current tempo, {} BPM", tempo.round())),
        _ => return format!("plays {what}, {span}"),
    };
    let (Some(true), Some(marker), Some(loop_start), Some(loop_end)) = (t.looping, t.start_marker, t.loop_start, t.loop_end) else {
        return format!("plays {what}, {span}{tempo_note}");
    };
    // A placement that ends before the loop begins never reaches it.
    if marker < loop_start && length <= (loop_start - marker) * scale + 1e-9 {
        return format!("plays {what}, {span}, before the loop starts{tempo_note}");
    }
    let region = LoopRegion { start_beats: loop_start * scale, end_beats: loop_end * scale };
    let marker = marker * scale;
    let passes = super::loop_pass_count(start, length, marker, &region);
    let Some(words) = super::pass_words(signature.unwrap(), start, length, marker, passes, &region) else {
        return format!("plays {what}, {span}");
    };
    format!("plays {what}, {span}, a {} loop played {}{}{tempo_note}", words.size, words.times, words.partial)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::OscType::{Bool, Float, Int, Nil, String as S};
    use serde_json::json;

    fn clip_reply(intervals: &[(f32, f32, i32, i32)]) -> Vec<OscType> {
        let mut r = vec![
            Int(3), Int(1), S("0".into()), S("ok".into()),
            S("/Users/someone/Samples/Vox/Lead Vox.wav".into()), Float(44100.0), Int(16000),
            Bool(true), Int(4), S("0.00 dB".into()), Int(9), Float(0.0), Int(intervals.len() as i32),
        ];
        for (a, b, fa, fb) in intervals {
            r.extend([Float(*a), Float(*b), Int(*fa), Int(*fb)]);
        }
        r.extend([Bool(true), Bool(false), Float(0.0), Float(0.0), Float(4.0), Float(152.0), Float(168.0), Float(135.0)]);
        r
    }

    #[test]
    fn a_clip_reply_decodes_settings_region_and_timing() {
        let read = decode_reply(&clip_reply(&[(0.0, 4.0, 0, 4000)]), 3, &SampleTarget::Index(0)).ok().unwrap();
        assert_eq!(read.path.as_ref().unwrap().file_name(), "Lead Vox.wav");
        assert_eq!((read.sample_rate, read.length_frames, read.warping, read.warp_mode), (Some(44100.0), Some(16000.0), Some(true), Some(4)));
        assert_eq!((read.gain.as_deref(), read.transpose, read.detune), (Some("0.00 dB"), Some(9.0), Some(0.0)));
        assert_eq!(read.intervals, vec![Interval { source: (0.0, 4.0), frames: (0.0, 4000.0) }]);
        let Holder::Clip(t) = read.holder else { panic!("clip") };
        assert_eq!((t.looping, t.loop_end, t.placement, t.tempo), (Some(true), Some(4.0), Some((152.0, 168.0)), Some(135.0)));
    }

    #[test]
    fn a_simpler_reply_decodes_its_mode_slices_and_loop() {
        let reply = vec![
            Int(1), Int(2), S("0.2.0".into()), S("ok".into()), S("/S/Perc 2.wav".into()), Float(44100.0), Int(1000),
            Bool(false), Int(0), S("0.00 dB".into()), Float(-3.0), Float(12.0), Int(1),
            Int(250), Int(750), Int(250), Int(750), Int(0), Int(2), Int(650), Int(750),
        ];
        let path = DevicePath::parse(Some(&serde_json::json!([0, 2, 0]))).unwrap();
        let read = decode_reply(&reply, 1, &SampleTarget::Device(path)).ok().unwrap();
        let Holder::Simpler(s) = read.holder else { panic!("simpler") };
        assert_eq!((s.mode, s.slices, s.loop_frames), (Some(0), Some(2), Some((650.0, 750.0))));
        assert_eq!(read.transpose, Some(-3.0));
    }

    #[test]
    fn nil_settings_decode_as_absent() {
        let mut reply = clip_reply(&[]);
        reply[9] = Nil;
        reply[11] = Nil;
        let read = decode_reply(&reply, 3, &SampleTarget::Index(0)).ok().unwrap();
        assert_eq!((read.gain, read.detune), (None, None));
        assert!(read.intervals.is_empty());
    }

    #[test]
    fn an_unreadable_path_keeps_the_other_settings() {
        // Review finding 1: a raising file_path arrives as nil.
        let mut reply = clip_reply(&[(0.0, 4.0, 0, 4000)]);
        reply[4] = Nil;
        let read = decode_reply(&reply, 3, &SampleTarget::Index(0)).ok().unwrap();
        assert!(read.path.is_none());
        let (p, _) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!((&p["file"], &p["transpose_semitones"]), (&serde_json::Value::Null, &json!(9.0)));
    }

    #[test]
    fn more_intervals_than_a_clip_can_play_is_malformed() {
        // Panel finding 1: the count is checked before anything is allocated.
        let reply = clip_reply(&[(0.0, 1.0, 0, 10), (1.0, 2.0, 10, 20), (2.0, 3.0, 20, 30)]);
        assert!(matches!(decode_reply(&reply, 3, &SampleTarget::Index(0)), Err(SampleError::Malformed)));
        let mut huge = clip_reply(&[]);
        huge[12] = Int(i32::MAX);
        assert!(matches!(decode_reply(&huge, 3, &SampleTarget::Index(0)), Err(SampleError::Malformed)));
    }

    #[test]
    fn a_status_reply_is_a_fixed_refusal() {
        for (status, reason) in [("not_audio_clip", "not_audio_clip"), ("empty_slot", "empty_slot"), ("no_such_target", "no_such_target"),
            ("not_a_simpler", "not_a_simpler"), ("no_sample", "no_sample"), ("multisample_not_readable", "multisample_not_readable"),
            ("sampler_not_readable", "sampler_not_readable"), ("path_too_long", "path_too_long")] {
            let reply = vec![Int(3), Int(1), S("0".into()), S(status.into())];
            assert!(matches!(decode_reply(&reply, 3, &SampleTarget::Index(0)), Err(SampleError::Refused(r)) if r == reason), "{status}");
        }
        // An unknown status is never echoed: it could carry anything.
        let odd = vec![Int(3), Int(1), S("0".into()), S("/Users/x/oops".into())];
        assert!(matches!(decode_reply(&odd, 3, &SampleTarget::Index(0)), Err(SampleError::Malformed)));
    }

    #[test]
    fn a_reply_for_another_target_or_a_short_record_is_malformed() {
        assert!(matches!(decode_reply(&clip_reply(&[]), 3, &SampleTarget::Index(1)), Err(SampleError::Malformed)));
        let mut short = clip_reply(&[(0.0, 4.0, 0, 4000)]);
        short.truncate(15);
        assert!(matches!(decode_reply(&short, 3, &SampleTarget::Index(0)), Err(SampleError::Malformed)));
    }

    #[test]
    fn the_file_name_drops_the_folder_on_either_separator() {
        assert_eq!(SourcePath("/Users/a/b/Kick.wav".into()).file_name(), "Kick.wav");
        assert_eq!(SourcePath("C:\\Users\\a\\Snare.aif".into()).file_name(), "Snare.aif");
        assert_eq!(SourcePath("Bare.wav".into()).file_name(), "Bare.wav");
        assert_eq!(format!("{:?}", SourcePath("/Users/secret/x.wav".into())), "SourcePath(..)");
    }

    #[test]
    fn targets_travel_as_a_kind_and_a_string() {
        assert_eq!((SampleTarget::Slot(2).kind(), SampleTarget::Slot(2).wire()), (0, "2".to_string()));
        assert_eq!((SampleTarget::Index(5).kind(), SampleTarget::Index(5).wire()), (1, "5".to_string()));
        let path = DevicePath::parse(Some(&serde_json::json!([0, 2, 0]))).unwrap();
        assert_eq!((SampleTarget::Device(path.clone()).kind(), SampleTarget::Device(path).wire()), (2, "0.2.0".to_string()));
    }

    fn clip_read(path: &str, intervals: Vec<Interval>, timing: ClipTiming) -> SampleRead {
        SampleRead {
            path: Some(SourcePath(path.into())), sample_rate: Some(44100.0), length_frames: Some(88200.0),
            warping: Some(true), warp_mode: Some(4), gain: Some("0.00 dB".into()),
            transpose: Some(9.0), detune: Some(0.0), intervals, holder: Holder::Clip(timing),
        }
    }

    fn timing(looping: bool, placement: Option<(f64, f64)>) -> ClipTiming {
        ClipTiming { looping: Some(looping), muted: Some(false), start_marker: Some(0.0), loop_start: Some(0.0),
            loop_end: Some(4.0), placement, tempo: Some(120.0) }
    }

    #[test]
    fn a_looped_arrangement_clip_says_how_often_it_plays() {
        // A 1-bar loop over bars 39-42, the last pass cut short.
        let read = clip_read("/S/Vox.wav", vec![Interval { source: (0.0, 4.0), frames: (0.0, 88200.0) }], timing(true, Some((152.0, 166.0))));
        let (p, missing) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!(missing, None);
        assert_eq!(p["source"], "arrangement_clip");
        assert_eq!(p["file"], crate::tools::fence::fence("Vox.wav"));
        assert_eq!((&p["warp"], &p["transpose_semitones"], &p["gain"]), (&json!("Complex"), &json!(9.0), &json!("0.00 dB")));
        assert_eq!(p["region"]["intervals_seconds"], json!([[0.0, 2.0]]));
        assert_eq!(p["region"]["plays"], "plays 0.00-2.00 s of the file, bars 39-42, a 1-bar loop played 4 times; the last pass is cut short");
        assert_eq!(p["start_position"], "39.1.1");
    }

    #[test]
    fn an_unlooped_session_clip_says_what_it_plays_when_launched() {
        let read = clip_read("/S/Vox.wav", vec![Interval { source: (0.0, 4.0), frames: (0.0, 88200.0) }], timing(false, None));
        let (p, _) = sample_payload(&read, 0, Some((4, 4)));
        assert_eq!(p["source"], "session_clip");
        assert_eq!(p["region"]["plays"], "plays 0.00-2.00 s of the file when launched");
    }

    #[test]
    fn a_session_intro_plays_once_before_the_loop() {
        // Review finding 3: start marker 0, loop 2-4 beats at 1 s per beat.
        let read = clip_read("/S/Vox.wav", vec![
            Interval { source: (0.0, 2.0), frames: (0.0, 44100.0) },
            Interval { source: (2.0, 4.0), frames: (44100.0, 88200.0) },
        ], ClipTiming { loop_start: Some(2.0), ..timing(true, None) });
        let (p, _) = sample_payload(&read, 0, Some((4, 4)));
        assert_eq!(p["region"]["plays"], "plays 0.00-1.00 s of the file once, then loops 1.00-2.00 s when launched");
    }

    #[test]
    fn an_unwarped_placement_names_the_tempo_it_assumes() {
        // Panel finding 2: no loop, but the seconds still depend on the tempo.
        let mut read = clip_read("/S/Crash.aif", vec![Interval { source: (0.0, 2.0), frames: (0.0, 88200.0) }],
            ClipTiming { loop_end: Some(2.0), ..timing(false, Some((0.0, 4.0))) });
        read.warping = Some(false);
        let (p, _) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!(p["region"]["plays"], "plays 0.00-2.00 s of the file, bar 1, at the current tempo, 120 BPM");
    }

    #[test]
    fn a_placement_that_ends_before_the_loop_says_no_loop() {
        // Panel finding 3: marker 0, loop 4-8 beats, a 2-beat placement plays
        // only the intro.
        let read = clip_read("/S/Vox.wav", vec![Interval { source: (0.0, 2.0), frames: (0.0, 44100.0) }],
            ClipTiming { loop_start: Some(4.0), loop_end: Some(8.0), ..timing(true, Some((0.0, 2.0))) });
        let (p, _) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!(p["region"]["plays"], "plays 0.00-1.00 s of the file, bar 1, before the loop starts");
    }

    #[test]
    fn a_simpler_of_unknown_mode_makes_no_pitch_claim() {
        // Panel finding 4: the mode could be Slice.
        let read = SampleRead {
            path: Some(SourcePath("/S/Perc 2.wav".into())), sample_rate: Some(1000.0), length_frames: Some(1000.0),
            warping: Some(false), warp_mode: Some(0), gain: None, transpose: Some(0.0), detune: Some(0.0),
            intervals: vec![], holder: Holder::Simpler(SimplerSettings { mode: None, slices: Some(0), loop_frames: None }),
        };
        let (p, _) = sample_payload(&read, 2, None);
        assert!(p.get("pitch").is_none(), "{p}");
    }

    #[test]
    fn an_unwarped_loop_counts_passes_at_the_current_tempo() {
        // Loop 0-0.5 s at 120 BPM is one beat; an 8-beat placement plays it 8 times.
        let mut read = clip_read("/S/Hit.wav", vec![Interval { source: (0.0, 0.5), frames: (0.0, 22050.0) }],
            ClipTiming { loop_end: Some(0.5), ..timing(true, Some((0.0, 8.0))) });
        read.warping = Some(false);
        let (p, _) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!(p["warp"], false);
        assert_eq!(p["region"]["plays"], "plays 0.00-0.50 s of the file, bars 1-2, a 1-beat loop played 8 times, at the current tempo, 120 BPM");
    }

    #[test]
    fn a_classic_simpler_names_its_region_loop_and_pitch() {
        let read = SampleRead {
            path: Some(SourcePath("/S/Perc 2.wav".into())), sample_rate: Some(1000.0), length_frames: Some(1000.0),
            warping: Some(false), warp_mode: Some(0), gain: Some("0.00 dB".into()), transpose: Some(-3.0), detune: Some(12.0),
            intervals: vec![Interval { source: (250.0, 750.0), frames: (250.0, 750.0) }],
            holder: Holder::Simpler(SimplerSettings { mode: Some(0), slices: Some(0), loop_frames: Some((650.0, 750.0)) }),
        };
        let (p, _) = sample_payload(&read, 2, None);
        assert_eq!((&p["source"], &p["mode"]), (&json!("simpler"), &json!("Classic")));
        assert_eq!(p["region"]["plays"], "a note plays 0.25-0.75 s of the file; held, it loops 0.65-0.75 s");
        assert!(p["pitch"].as_str().unwrap().contains("C3 plays the sample at its original pitch"));
        assert!(p.get("slices").is_none());
    }

    #[test]
    fn a_slice_simpler_counts_slices_and_drops_the_pitch_line() {
        let read = SampleRead {
            path: Some(SourcePath("/S/Break.wav".into())), sample_rate: Some(1000.0), length_frames: Some(2000.0),
            warping: Some(false), warp_mode: Some(0), gain: None, transpose: Some(0.0), detune: Some(0.0),
            intervals: vec![Interval { source: (0.0, 2000.0), frames: (0.0, 2000.0) }],
            holder: Holder::Simpler(SimplerSettings { mode: Some(2), slices: Some(8), loop_frames: None }),
        };
        let (p, _) = sample_payload(&read, 2, None);
        assert_eq!((&p["mode"], &p["slices"]), (&json!("Slice"), &json!(8)));
        // Review finding 4: in Thru, a note plays on past its slice, so the
        // words promise nothing about one note per slice.
        assert_eq!(p["region"]["plays"], "slices are cut from 0.00-2.00 s of the file");
        assert!(p.get("pitch").is_none());
    }

    #[test]
    fn a_missing_region_keeps_the_settings_and_names_the_gap() {
        let read = clip_read("/S/Vox.wav", vec![], timing(true, Some((0.0, 4.0))));
        let (p, missing) = sample_payload(&read, 1, Some((4, 4)));
        assert_eq!(missing, Some("region_unavailable"));
        assert_eq!(p["transpose_semitones"], 9.0);
        assert!(p.get("region").is_none());
    }

    #[test]
    fn warp_modes_have_names_and_an_unknown_fallback() {
        let names: Vec<_> = [0, 1, 2, 3, 4, 5, 6, 9].iter().map(|m| warp_name(*m)).collect();
        assert_eq!(names, ["Beats", "Tones", "Texture", "Re-Pitch", "Complex", "REX", "Complex Pro", "unknown"]);
    }

    #[test]
    fn the_folder_never_reaches_the_result() {
        for path in ["/Users/someone/Music/Samples/«Vox»/Lead «Vox».wav", "C:\\Users\\someone\\Samples\\Snare.aif", "/Users/ü/Ünïcode/Hat 🎩.wav"] {
            let read = clip_read(path, vec![Interval { source: (0.0, 4.0), frames: (0.0, 88200.0) }], timing(false, None));
            let (p, _) = sample_payload(&read, 0, None);
            let text = serde_json::to_string(&p).unwrap();
            assert!(!text.contains("Users"), "{text}");
            assert!(!text.contains("Samples"), "{text}");
            assert_eq!(p["file"], crate::tools::fence::fence(read.path.as_ref().unwrap().file_name()));
        }
    }

    #[test]
    fn the_default_result_stays_under_a_kilobyte() {
        let read = clip_read("/S/A fairly long sample file name for a vocal take 12.wav",
            vec![Interval { source: (6.0, 8.0), frames: (0.0, 44100.0) }, Interval { source: (0.0, 2.0), frames: (44100.0, 88200.0) }],
            timing(true, Some((152.0, 166.0))));
        let (p, _) = sample_payload(&read, 1, Some((4, 4)));
        assert!(serde_json::to_string(&p).unwrap().len() < 1024);
    }

    #[test]
    fn reversed_or_endless_intervals_are_malformed() {
        // The profile cuts inside each interval; a reversed one would panic it.
        for bad in [(0.0, 4.0, 4000, 1000), (0.0, f32::INFINITY, 0, 4000), (0.0, 4.0, 0, 0)] {
            assert!(matches!(decode_reply(&clip_reply(&[bad]), 3, &SampleTarget::Index(0)), Err(SampleError::Malformed)), "{bad:?}");
        }
    }

    #[test]
    fn beats_travel_as_one_short_string() {
        assert_eq!(beats_wire(&[0.0, 1.0, 2.5, 1.0 / 3.0]), "0,1,2.5,0.333333");
    }

    #[test]
    fn a_frames_reply_decodes_one_frame_per_beat() {
        let t = SampleTarget::Index(0);
        let reply = vec![Int(3), Int(1), S("0".into()), S("0,1,2.5".into()), S("ok".into()), Int(3), Int(0), Int(1000), Nil];
        assert_eq!(decode_frames_reply(&reply, 3, &t, "0,1,2.5", 3).ok(), Some(vec![Some(0.0), Some(1000.0), None]));
    }

    #[test]
    fn a_frames_reply_for_other_beats_or_a_wrong_count_is_malformed() {
        let t = SampleTarget::Index(0);
        let reply = vec![Int(3), Int(1), S("0".into()), S("0,1".into()), S("ok".into()), Int(2), Int(0), Int(1000)];
        assert!(matches!(decode_frames_reply(&reply, 3, &t, "0,2", 2), Err(SampleError::Malformed)));
        assert!(matches!(decode_frames_reply(&reply, 3, &t, "0,1", 3), Err(SampleError::Malformed)));
    }

    #[test]
    fn a_frames_status_is_a_fixed_refusal() {
        let t = SampleTarget::Slot(0);
        let reply = vec![Int(3), Int(0), S("0".into()), S("0".into()), S("not_warped".into())];
        assert!(matches!(decode_frames_reply(&reply, 3, &t, "0", 1), Err(SampleError::Refused("not_warped"))));
        let odd = vec![Int(3), Int(0), S("0".into()), S("0".into()), S("/Users/x".into())];
        assert!(matches!(decode_frames_reply(&odd, 3, &t, "0", 1), Err(SampleError::Malformed)));
    }

    use crate::analysis::levels::{LevelStats, Tail};
    use crate::analysis::pitch::Pitch;
    use crate::analysis::signals::{interleave, sine, wav, wav_in};
    use crate::analysis::spectrum::SpectrumStats;
    use crate::analysis::stereo::StereoStats;
    use crate::analysis::Stats;

    fn unwarped(frames: (f64, f64), transpose: f64) -> SampleRead {
        let mut r = clip_read("/S/Hit.wav", vec![Interval { source: (frames.0 / 1000.0, frames.1 / 1000.0), frames }], timing(false, None));
        (r.sample_rate, r.warping, r.transpose) = (Some(1000.0), Some(false), Some(transpose));
        r
    }

    #[test]
    fn half_second_segments_lengthen_evenly_past_64() {
        let s = time_segments(&unwarped((0.0, 3000.0), 0.0), 1000.0);
        assert_eq!(s.len(), 6);
        assert_eq!((s[1].at_s, s[1].stream, s[1].beat), (0.5, (500, 1000), None));
        let long = time_segments(&unwarped((0.0, 40_000.0), 0.0), 1000.0);
        assert_eq!((long.len(), long[1].stream), (40, (1000, 2000)));
    }

    #[test]
    fn segments_follow_playback_across_two_intervals() {
        let mut r = unwarped((2000.0, 3000.0), 0.0);
        r.intervals.push(Interval { source: (0.0, 1.0), frames: (0.0, 1000.0) });
        let s = time_segments(&r, 1000.0);
        assert_eq!(s.iter().map(|s| (s.at_s, s.stream)).collect::<Vec<_>>(), vec![(2.0, (0, 500)), (2.5, (500, 1000)), (0.0, (1000, 1500)), (0.5, (1500, 2000))]);
    }

    #[test]
    fn beat_positions_cover_each_interval_within_65() {
        let one = |a, b| vec![Interval { source: (a, b), frames: (0.0, 1.0) }];
        assert_eq!(beat_positions(&one(0.0, 4.0)), vec![vec![0.0, 1.0, 2.0, 3.0, 4.0]]);
        assert_eq!(beat_positions(&one(0.5, 3.5)), vec![vec![0.5, 1.0, 2.0, 3.0, 3.5]]);
        let long = beat_positions(&one(0.0, 200.0));
        assert!(long[0].len() <= 65 && long[0].first() == Some(&0.0) && long[0].last() == Some(&200.0), "{long:?}");
    }

    #[test]
    fn beat_segments_use_the_frames_live_gave() {
        let mut r = unwarped((0.0, 2000.0), 0.0);
        r.intervals[0].source = (0.0, 2.0);
        let s = beat_segments(&r, &[vec![0.0, 1.0, 2.0]], &[Some(0.0), Some(900.0), Some(2000.0)], 1000.0).unwrap();
        assert_eq!(s.iter().map(|s| (s.beat, s.stream)).collect::<Vec<_>>(), vec![(Some(0.0), (0, 900)), (Some(1.0), (900, 2000))]);
        assert_eq!(beat_segments(&r, &[vec![0.0, 1.0, 2.0]], &[Some(0.0), None, Some(2000.0)], 1000.0), None);
    }

    fn analysed(read: &SampleRead) -> Stats {
        let x = sine(44_100, 440.0, 1.0, 0.5);
        let path = wav(44_100, 2, &interleave(&x, &x));
        crate::analysis::analyse(&path, &region_frames(read), None, std::time::Instant::now() + Duration::from_secs(20)).unwrap()
    }

    fn sine_read(transpose: f64) -> SampleRead {
        let mut r = clip_read("/S/Tone.wav", vec![Interval { source: (0.0, 1.0), frames: (0.0, 44_100.0) }], timing(false, None));
        (r.warping, r.transpose) = (Some(false), Some(transpose));
        r
    }

    #[test]
    fn the_analysis_names_the_pitch_before_and_after_transpose() {
        let stats = analysed(&sine_read(0.0));
        let up = analysis_payload(&stats, &sine_read(3.0), &Profile::Off);
        let down = analysis_payload(&stats, &sine_read(-3.0), &Profile::Off);
        assert_eq!(up["about"], ABOUT);
        assert_eq!((&up["pitch"]["note"], &up["pitch_after_transpose"]["note"]), (&json!("A3"), &json!("C4")));
        assert_eq!(down["pitch_after_transpose"]["note"], "F#3");
        assert_eq!(up["stereo"]["correlation"], 1.0);
        assert_eq!(up["null_because"]["stereo.side_to_mid_db"], "no_side");
    }

    #[test]
    fn re_pitch_gives_no_pitch_after_transpose() {
        let stats = analysed(&sine_read(0.0));
        let mut read = sine_read(3.0);
        (read.warping, read.warp_mode) = (Some(true), Some(3));
        let p = analysis_payload(&stats, &read, &Profile::Off);
        assert_eq!((&p["pitch_after_transpose"], &p["null_because"]["pitch_after_transpose"]), (&Value::Null, &json!("re_pitch")));
    }

    fn worst_case(segments: usize) -> Stats {
        Stats {
            rate: 44_100, channels: 2, seconds: 599.99,
            levels: LevelStats {
                sample_peak_dbfs: vec![Ok(-0.12), Ok(-0.34)], true_peak_dbfs: Ok(0.27), full_scale_samples: 123_456,
                rms_dbfs: Ok(-14.23), crest_db: Ok(14.11), silent_share: 0.123, leading_silence_ms: Ok(1234.0),
                attack_ms: Some(12), tail: Some(Tail::AtLeast(4567)), segment_rms_dbfs: vec![Ok(-14.25); segments],
            },
            spectrum: SpectrumStats { band_shares: Ok([0.123; 7]), centroid_hz: Ok(1834.6), onsets: 1, segment_centroid_hz: vec![Ok(1834.6); segments] },
            stereo: Ok(StereoStats { correlation: Ok(0.876), side_to_mid_db: Ok(-12.34), low_correlation: Ok(0.99), low_side_to_mid_db: Ok(-31.2) }),
            pitch: Pitch::Sweep { from_hz: 98.76, tail_hz: 55.12 },
            onsets_per_second: Ok(3.21),
            missing_frames: 0,
        }
    }

    #[test]
    fn the_result_stays_under_two_kilobytes_with_analysis_and_four_with_a_profile() {
        let read = clip_read("/S/A fairly long sample file name for a vocal take 12.wav",
            vec![Interval { source: (6.0, 8.0), frames: (0.0, 44100.0) }, Interval { source: (0.0, 2.0), frames: (44100.0, 88200.0) }],
            timing(true, Some((152.0, 166.0))));
        let (mut p, _) = sample_payload(&read, 1, Some((4, 4)));
        p["channels"] = json!(2);
        p["analysis"] = analysis_payload(&worst_case(0), &read, &Profile::Off);
        assert!(serde_json::to_string(&p).unwrap().len() < 2048, "{p}");
        let segments = (0..66).map(|i| Segment { beat: Some(123.25 + i as f64), at_s: 345.67, stream: (0, 1) }).collect();
        p["analysis"] = analysis_payload(&worst_case(66), &read, &Profile::Segments(segments));
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.len() < 4096, "{} bytes", text.len());
    }

    #[test]
    fn a_profile_is_columns_and_a_null_says_why() {
        let segments = vec![Segment { beat: Some(0.0), at_s: 0.0, stream: (0, 1) }, Segment { beat: Some(1.0), at_s: 0.5, stream: (1, 2) }];
        let mut stats = worst_case(2);
        stats.levels.segment_rms_dbfs[1] = Err("silent");
        let p = analysis_payload(&stats, &sine_read(0.0), &Profile::Segments(segments));
        assert_eq!(p["profile"]["beat"], json!([0.0, 1.0]));
        assert_eq!(p["profile"]["rms_dbfs"], json!([-14.3, null]));
        assert_eq!(p["profile"]["centroid_hz"], json!([1830.0, 1830.0]));
        let none = analysis_payload(&stats, &sine_read(0.0), &Profile::Unavailable("region_too_short"));
        assert_eq!((&none["profile"], &none["null_because"]["profile"]), (&Value::Null, &json!("region_too_short")));
    }

    #[test]
    fn a_file_shorter_than_its_region_names_the_gap_and_drops_the_profile() {
        // The missing tail is not silence, and later segments would be shifted.
        let segments = vec![Segment { beat: None, at_s: 0.0, stream: (0, 1) }, Segment { beat: None, at_s: 0.5, stream: (1, 2) }];
        let mut stats = worst_case(2);
        stats.missing_frames = 22_050;
        let p = analysis_payload(&stats, &sine_read(0.0), &Profile::Segments(segments));
        assert_eq!((&p["file_short_by_s"], &p["profile"]), (&json!(0.5), &Value::Null));
        assert_eq!(p["null_because"]["profile"], "file_shorter_than_region");
        stats.missing_frames = 100;
        assert!(analysis_payload(&stats, &sine_read(0.0), &Profile::Off).get("file_short_by_s").is_none());
    }

    #[tokio::test]
    async fn no_folder_reaches_the_analysis_whether_it_reads_or_fails() {
        let missing = clip_read("/Users/someone/Secret Folder/gone.wav", vec![Interval { source: (0.0, 1.0), frames: (0.0, 100.0) }], timing(false, None));
        let (block, channels) = analysis_block(&missing, &Profile::Off).await.unwrap();
        assert_eq!((&block["missing_reason"], &block["about"], channels), (&json!("file_missing"), &json!(ABOUT), None));
        let path = wav_in("Secret Folder", 44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        let mut read = sine_read(0.0);
        read.path = Some(SourcePath(path.to_string_lossy().into_owned()));
        read.intervals = vec![Interval { source: (0.0, 0.2), frames: (0.0, 8820.0) }];
        let (block, channels) = analysis_block(&read, &Profile::Off).await.unwrap();
        assert_eq!(channels, Some(1));
        let text = block.to_string();
        assert!(!text.contains("Secret") && !text.contains("mixingpal-") && text.contains("A3"), "{text}");
    }

    #[tokio::test]
    async fn no_region_means_no_analysis() {
        let read = clip_read("/S/Vox.wav", vec![], timing(true, Some((0.0, 4.0))));
        assert!(analysis_block(&read, &Profile::Off).await.is_none());
    }
}
