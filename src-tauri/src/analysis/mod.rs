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
    /// Region frames the file did not have: Live counted more than the
    /// decoder found, as for a file cut short.
    pub missing_frames: u64,
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
    // Live never plays the audio before a region, so nothing is measured
    // from it. It only says whether the region's start is an onset: a cut
    // mid-note is not. One at the file's start begins from silence.
    if let Some(&(start, _)) = regions.first().filter(|r| r.0 > 0) {
        let mut before = Vec::new();
        source.stream(&[(start.saturating_sub(spectrum::FFT as u64), start)], deadline, &mut |c| before.extend_from_slice(c))?;
        spectrum.prime(&before);
    }
    let frames = source.stream(regions, deadline, &mut |chunk| {
        levels.push(chunk);
        spectrum.push(chunk);
        if let Some(s) = stereo.as_mut() {
            s.push(chunk);
        }
        pitch.push(chunk, channels);
    })?;
    if frames == 0 {
        // A file that decodes from its start only ends before the region.
        let decodes = source.stream(&[(0, 1)], deadline, &mut |_| {})? > 0;
        return Err(if decodes { AnalysisError::FileShorterThanRegion } else { AnalysisError::DecodeFailed });
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
        missing_frames: regions.iter().map(|(a, b)| b.saturating_sub(*a)).sum::<u64>().saturating_sub(frames),
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
    fn a_region_past_the_files_end_says_the_file_is_shorter() {
        // The file was bounced again, shorter, under the same name.
        let path = wav(44_100, 1, &sine(44_100, 440.0, 0.1, 0.5));
        assert_eq!(analyse(&path, &[(90_000, 91_000)], None, later()).err(), Some(decode::AnalysisError::FileShorterThanRegion));
    }

    #[test]
    fn a_file_with_no_audio_is_a_decode_failure() {
        let path = wav(44_100, 1, &[]);
        assert_eq!(analyse(&path, &[(0, 1_000)], None, later()).err(), Some(decode::AnalysisError::DecodeFailed));
    }

    /// 60 Hz at -0.9 dBFS whose crest falls on frame `crest`.
    fn crest_at(crest: usize) -> Vec<f32> {
        let a = 10f64.powf(-0.9 / 20.0);
        (0..88_200).map(|i| (a * (2.0 * std::f64::consts::PI * 60.0 * (i as f64 - crest as f64) / 44_100.0).cos()) as f32).collect()
    }

    #[test]
    fn a_region_cut_at_a_crest_has_no_false_true_peak() {
        // From the file's start, and mid-file where the audio before settles it.
        for (crest, start) in [(0, 0), (22_050, 22_050)] {
            let path = wav(44_100, 1, &crest_at(crest));
            let s = analyse(&path, &[(start, 88_200)], None, later()).unwrap();
            let (sample, true_peak) = (s.levels.sample_peak_dbfs[0].unwrap(), s.levels.true_peak_dbfs.unwrap());
            assert!(true_peak < sample + 0.1, "{start}: true {true_peak} sample {sample}");
        }
    }

    #[test]
    fn a_region_cut_mid_note_has_no_onset_at_its_start() {
        let path = wav(44_100, 1, &sine(44_100, 220.0, 2.0, 0.5));
        let s = analyse(&path, &[(22_050, 66_150)], None, later()).unwrap();
        assert_eq!((s.onsets_per_second, s.levels.attack_ms), (Ok(0.0), None));
    }

    #[test]
    fn a_hit_on_the_region_start_still_counts() {
        let mut x = vec![0.0f32; 22_050];
        x.extend(sine(44_100, 1000.0, 0.5, 0.8).iter().enumerate().map(|(i, v)| v * (-(i as f32) / 4410.0).exp()));
        let path = wav(44_100, 1, &x);
        let s = analyse(&path, &[(22_050, 44_100)], None, later()).unwrap();
        assert_eq!(s.onsets_per_second, Ok(2.0));
    }

    #[test]
    fn a_region_after_louder_audio_is_measured_on_its_own_samples() {
        // Live never plays the audio before the start marker.
        let mut x = sine(44_100, 5000.0, 1.0, 0.9);
        x.extend(sine(44_100, 100.0, 1.0, 0.01));
        let path = wav(44_100, 1, &x);
        let s = analyse(&path, &[(44_100, 88_200)], None, later()).unwrap();
        assert!(s.levels.true_peak_dbfs.unwrap() < -39.0, "{:?}", s.levels.true_peak_dbfs);
        assert!(s.spectrum.centroid_hz.unwrap() < 150.0, "{:?}", s.spectrum.centroid_hz);
        assert!(s.spectrum.band_shares.unwrap()[1] > 0.99, "{:?}", s.spectrum.band_shares);
    }

    #[test]
    fn a_file_shorter_than_its_region_says_by_how_much() {
        let path = wav(44_100, 1, &sine(44_100, 440.0, 1.0, 0.5));
        let s = analyse(&path, &[(0, 88_200)], None, later()).unwrap();
        assert_eq!((s.missing_frames, s.seconds), (44_100, 1.0));
    }
}
