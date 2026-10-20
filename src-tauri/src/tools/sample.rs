//! get_sample's read: one audio clip or Simpler, its file, settings and the
//! region Live plays, mapped to frames inside Live. The reply layout is
//! `mixingpal/sample_replies.py`'s.

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
/// it, so it cannot reach a tool result, a trace, or the proxy. PR 2 opens
/// the file with it.
pub struct SourcePath(pub(crate) String);

impl SourcePath {
    /// The file name alone, cut on either separator before any fencing.
    pub fn file_name(&self) -> &str {
        self.0.rsplit(['/', '\\']).next().unwrap_or("")
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
    pub path: SourcePath,
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
        return STATUSES.iter().find(|s| **s == status).map(|s| Err(SampleError::Refused(*s))).unwrap_or(Err(SampleError::Malformed));
    }
    let at = |i: usize| reply.get(4 + i);
    let path = string(at(0))?.ok_or(SampleError::Malformed)?;
    let count = int(at(SETTINGS))?.ok_or(SampleError::Malformed)?;
    let count = usize::try_from(count).map_err(|_| SampleError::Malformed)?;
    let first = 4 + SETTINGS + 1;
    let extra = first + 4 * count;
    let mut intervals = Vec::with_capacity(count);
    for i in 0..count {
        let n = |j: usize| number(reply.get(first + 4 * i + j));
        let (Some(a), Some(b), Some(fa), Some(fb)) = (n(0)?, n(1)?, n(2)?, n(3)?) else {
            return Err(SampleError::Malformed);
        };
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
        path: SourcePath(path),
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
        "file": fence(read.path.file_name()),
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
            } else {
                p["pitch"] = json!("pitch follows the MIDI note: C3 plays the sample at its original pitch plus Transpose and Detune");
            }
            if let (Some(rate), None) = (rate, missing) {
                let what = ranges(&read.intervals, rate);
                let plays = match (mode, s.loop_frames) {
                    (Some("Slice"), _) => format!("slices are cut from {what}; each note plays one slice"),
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
        let verb = if t.looping == Some(true) { "loops" } else { "plays" };
        return format!("{verb} {what} when launched");
    };
    let length = end - start;
    let Some(beats_per_bar) = signature.and_then(super::beats_per_bar) else {
        return format!("plays {what}");
    };
    let span = super::bar_span(start, length, beats_per_bar);
    let (Some(true), Some(marker), Some(loop_start), Some(loop_end)) = (t.looping, t.start_marker, t.loop_start, t.loop_end) else {
        return format!("plays {what}, {span}");
    };
    // Pass counting runs in song beats. An unwarped clip's markers are
    // seconds, so they convert at the current tempo, and the words say so.
    let (scale, tempo_note) = match (read.warping, t.tempo) {
        (Some(true), _) => (1.0, String::new()),
        (Some(false), Some(tempo)) if tempo > 0.0 => (tempo / 60.0, format!(", at the current tempo, {} BPM", tempo.round())),
        _ => return format!("plays {what}, {span}"),
    };
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
        assert_eq!(read.path.file_name(), "Lead Vox.wav");
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
            path: SourcePath(path.into()), sample_rate: Some(44100.0), length_frames: Some(88200.0),
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
            path: SourcePath("/S/Perc 2.wav".into()), sample_rate: Some(1000.0), length_frames: Some(1000.0),
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
            path: SourcePath("/S/Break.wav".into()), sample_rate: Some(1000.0), length_frames: Some(2000.0),
            warping: Some(false), warp_mode: Some(0), gain: None, transpose: Some(0.0), detune: Some(0.0),
            intervals: vec![Interval { source: (0.0, 2000.0), frames: (0.0, 2000.0) }],
            holder: Holder::Simpler(SimplerSettings { mode: Some(2), slices: Some(8), loop_frames: None }),
        };
        let (p, _) = sample_payload(&read, 2, None);
        assert_eq!((&p["mode"], &p["slices"]), (&json!("Slice"), &json!(8)));
        assert_eq!(p["region"]["plays"], "slices are cut from 0.00-2.00 s of the file; each note plays one slice");
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
            assert_eq!(p["file"], crate::tools::fence::fence(read.path.file_name()));
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
}
