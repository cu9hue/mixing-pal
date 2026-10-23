//! What a sample's played region contains: level, spectrum, stereo, pitch and
//! transients, measured from the file in the app. Nothing here describes the
//! mix: the region is read before clip gain, warping, devices and the fader.

pub mod cache;
pub mod decode;
pub mod levels;
pub mod pitch;
pub mod spectrum;
pub mod stereo;

use decode::{AnalysisError, Source};
use levels::LevelStats;
use pitch::Pitch;
use spectrum::SpectrumStats;
use std::path::Path;
use std::time::Instant;
use stereo::StereoStats;

/// Everything measured about one region of one file. Small: no envelope or
/// frame-by-frame series survives, so a cache of 256 stays cheap.
#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub rate: u32,
    pub channels: usize,
    pub seconds: f64,
    pub levels: LevelStats,
    pub spectrum: SpectrumStats,
    pub stereo: Result<StereoStats, &'static str>,
    pub pitch: Pitch,
    pub onsets_per_second: Stat,
}

/// Decodes the regions once, in order, feeding every measure. Blocking:
/// call it from `spawn_blocking`. `segments` are ranges of the decoded
/// stream, which plays the regions back to back.
pub fn analyse(path: &Path, regions: &[(u64, u64)], segments: Option<&[(u64, u64)]>, deadline: Instant) -> Result<Stats, AnalysisError> {
    let mut source = Source::open(path)?;
    let (rate, channels) = (source.rate, source.channels);
    let segments = segments.unwrap_or(&[]).to_vec();
    let mut levels = levels::Levels::new(rate, channels, segments.clone());
    let mut spectrum = spectrum::Spectrum::new(rate, channels, segments);
    let mut stereo = (channels == 2).then(|| stereo::Stereo::new(rate));
    let mut pitch = pitch::PitchTracker::new(rate);
    let frames = source.stream(regions, deadline, &mut |chunk| {
        levels.push(chunk);
        spectrum.push(chunk);
        if let Some(s) = stereo.as_mut() {
            s.push(chunk);
        }
        pitch.push(chunk, channels);
    })?;
    if frames == 0 {
        return Err(AnalysisError::DecodeFailed);
    }
    let seconds = frames as f64 / f64::from(rate);
    let spectrum = spectrum.finish();
    Ok(Stats {
        rate,
        channels,
        seconds,
        levels: levels.finish(spectrum.onsets == 1),
        onsets_per_second: Ok(spectrum.onsets as f64 / seconds),
        spectrum,
        stereo: stereo.map(stereo::Stereo::finish).ok_or("mono_file"),
        pitch: pitch.finish(),
    })
}
#[cfg(test)]
pub(crate) mod signals;

/// A measured value, or why there is none. Never 0 in place of a reason.
pub type Stat = Result<f64, &'static str>;

pub(crate) fn amp_db(x: f64) -> Stat {
    if x > 0.0 { Ok(20.0 * x.log10()) } else { Err("silent") }
}

pub(crate) fn power_db(x: f64) -> Stat {
    if x > 0.0 { Ok(10.0 * x.log10()) } else { Err("silent") }
}

/// Which profile segment a stream position falls in. Positions only grow, so
/// the cursor only moves forward.
pub(crate) struct Segments {
    ranges: Vec<(u64, u64)>,
    cursor: usize,
}

impl Segments {
    pub fn new(ranges: Vec<(u64, u64)>) -> Self {
        Segments { ranges, cursor: 0 }
    }

    pub fn at(&mut self, position: u64) -> Option<usize> {
        while self.cursor < self.ranges.len() && self.ranges[self.cursor].1 <= position {
            self.cursor += 1;
        }
        (self.cursor < self.ranges.len() && self.ranges[self.cursor].0 <= position).then_some(self.cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_position_finds_its_segment_and_gaps_find_none() {
        let mut s = Segments::new(vec![(0, 10), (20, 30)]);
        assert_eq!((s.at(0), s.at(9), s.at(10), s.at(20), s.at(29), s.at(30)), (Some(0), Some(0), None, Some(1), Some(1), None));
    }

    #[test]
    fn silence_has_no_decibels() {
        assert_eq!(amp_db(0.0), Err("silent"));
        assert!((amp_db(0.5).unwrap() + 6.0206).abs() < 1e-3);
        assert!((power_db(0.01).unwrap() + 20.0).abs() < 1e-9);
    }

    use super::signals::{interleave, sine, wav};
    use std::time::{Duration, Instant};

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    #[test]
    fn one_pass_measures_a_stereo_sine() {
        let x = sine(44_100, 440.0, 1.0, 0.5);
        let path = wav(44_100, 2, &interleave(&x, &x));
        let s = analyse(&path, &[(0, 44_100)], None, later()).unwrap();
        assert_eq!((s.rate, s.channels), (44_100, 2));
        assert!((s.seconds - 1.0).abs() < 1e-9);
        assert!(matches!(s.pitch, pitch::Pitch::Steady(hz) if (hz - 440.0).abs() < 2.0), "{:?}", s.pitch);
        assert!((s.stereo.as_ref().unwrap().correlation.unwrap() - 1.0).abs() < 1e-3);
        assert!(s.spectrum.band_shares.unwrap()[2] > 0.9);
        assert_eq!(s.onsets_per_second, Ok(1.0));
        assert!(s.levels.attack_ms.is_some(), "one onset gives an attack");
    }

    #[test]
    fn a_mono_file_has_no_stereo_stats() {
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.2, 0.5));
        assert_eq!(analyse(&path, &[(0, 8_820)], None, later()).unwrap().stereo, Err("mono_file"));
    }

    #[test]
    fn a_silent_region_answers_with_reasons_not_zeros() {
        let path = wav(44_100, 1, &vec![0.0; 44_100]);
        let s = analyse(&path, &[(0, 44_100)], None, later()).unwrap();
        assert_eq!((s.levels.rms_dbfs, s.spectrum.centroid_hz, s.pitch), (Err("silent"), Err("silent"), pitch::Pitch::Unknown("silent")));
        assert_eq!(s.onsets_per_second, Ok(0.0));
    }

    #[test]
    fn segments_are_measured_on_the_stream_the_regions_make() {
        // Two regions played back to back; the segments follow playback.
        let mut x = sine(44_100, 500.0, 1.0, 0.5);
        x.extend(vec![0.0; 44_100]);
        let path = wav(44_100, 1, &x);
        let s = analyse(&path, &[(44_100, 66_150), (0, 22_050)], Some(&[(0, 22_050), (22_050, 44_100)]), later()).unwrap();
        assert_eq!(s.levels.segment_rms_dbfs[0], Err("silent"));
        assert!(s.levels.segment_rms_dbfs[1].is_ok());
        assert!(s.spectrum.segment_centroid_hz[1].is_ok());
    }

    #[test]
    fn a_region_with_no_frames_is_a_decode_failure() {
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5));
        assert_eq!(analyse(&path, &[(90_000, 91_000)], None, later()).err(), Some(decode::AnalysisError::DecodeFailed));
    }
}
