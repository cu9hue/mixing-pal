//! get_sample's read: one audio clip or Simpler, its file, settings and the
//! region Live plays, mapped to frames inside Live. The reply layout is
//! `mixingpal/sample_replies.py`'s.

use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::path::DevicePath;
use rosc::OscType;
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
#[cfg(test)]
mod tests {
    use super::*;
    use rosc::OscType::{Bool, Float, Int, Nil, String as S};

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
}
