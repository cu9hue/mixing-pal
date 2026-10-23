//! Level stats over the decoded region: peaks, RMS, full-scale samples, and a
//! 1 ms peak envelope for silence, attack and tail.

use super::{amp_db, power_db, Segments, Stat};
use std::f64::consts::PI;

/// -0.01 dBFS. A count, not a clipping verdict: clipped audio can be turned
/// down later and still be clipped, and full-scale audio need not be.
const FULL_SCALE: f32 = 0.998_849;
/// -60 dBFS, as an amplitude.
const SILENT: f32 = 0.001;
/// The envelope holds each 1 ms block's peak for 10 ms, so a low note's
/// zero crossings do not read as silence.
const HOLD_BLOCKS: usize = 10;
const TAPS: usize = 16;
const OVERSAMPLE: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tail {
    Ms(u64),
    /// The region ended before the tail fell 60 dB.
    AtLeast(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LevelStats {
    pub sample_peak_dbfs: Vec<Stat>,
    pub true_peak_dbfs: Stat,
    pub full_scale_samples: u64,
    pub rms_dbfs: Stat,
    pub crest_db: Stat,
    pub silent_share: f64,
    pub leading_silence_ms: Stat,
    pub attack_ms: Option<u64>,
    pub tail: Option<Tail>,
    pub segment_rms_dbfs: Vec<Stat>,
}

pub struct Levels {
    channels: usize,
    block: usize,
    peak: Vec<f32>,
    true_peak: f32,
    full_scale: u64,
    sum_squares: f64,
    frames: u64,
    history: Vec<[f32; TAPS]>,
    kernel: [[f32; TAPS]; OVERSAMPLE - 1],
    block_max: f32,
    in_block: usize,
    blocks: Vec<f32>,
    segments: Segments,
    segment_sums: Vec<(f64, u64)>,
}

/// Windowed-sinc taps for the three points between two samples at 4x.
fn kernel() -> [[f32; TAPS]; OVERSAMPLE - 1] {
    let mut k = [[0.0; TAPS]; OVERSAMPLE - 1];
    let half = (TAPS / 2) as f64;
    for (p, row) in k.iter_mut().enumerate() {
        let t = half - 1.0 + (p + 1) as f64 / OVERSAMPLE as f64;
        for (i, tap) in row.iter_mut().enumerate() {
            let x = t - i as f64;
            let sinc = if x == 0.0 { 1.0 } else { (PI * x).sin() / (PI * x) };
            *tap = (sinc * 0.5 * (1.0 + (PI * x / half).cos())) as f32;
        }
    }
    k
}

impl Levels {
    pub fn new(rate: u32, channels: usize, segments: Vec<(u64, u64)>) -> Self {
        let n = segments.len();
        Levels {
            channels,
            block: (rate as usize / 1000).max(1),
            peak: vec![0.0; channels],
            true_peak: 0.0,
            full_scale: 0,
            sum_squares: 0.0,
            frames: 0,
            history: vec![[0.0; TAPS]; channels],
            kernel: kernel(),
            block_max: 0.0,
            in_block: 0,
            blocks: Vec::new(),
            segments: Segments::new(segments),
            segment_sums: vec![(0.0, 0); n],
        }
    }

    pub fn push(&mut self, chunk: &[f32]) {
        for frame in chunk.chunks_exact(self.channels) {
            let mut loudest = 0.0f32;
            let mut squares = 0.0f64;
            for (c, &x) in frame.iter().enumerate() {
                let a = x.abs();
                self.peak[c] = self.peak[c].max(a);
                if a >= FULL_SCALE {
                    self.full_scale += 1;
                }
                squares += f64::from(x) * f64::from(x);
                loudest = loudest.max(a);
                let h = &mut self.history[c];
                h.copy_within(1.., 0);
                h[TAPS - 1] = x;
                for taps in &self.kernel {
                    let y: f32 = taps.iter().zip(h.iter()).map(|(t, v)| t * v).sum();
                    self.true_peak = self.true_peak.max(y.abs());
                }
            }
            self.sum_squares += squares;
            if let Some(i) = self.segments.at(self.frames) {
                self.segment_sums[i].0 += squares;
                self.segment_sums[i].1 += 1;
            }
            self.frames += 1;
            self.block_max = self.block_max.max(loudest);
            self.in_block += 1;
            if self.in_block == self.block {
                self.blocks.push(self.block_max);
                self.block_max = 0.0;
                self.in_block = 0;
            }
        }
    }

    /// `one_onset`: the region holds one hit, so attack and tail mean
    /// something. The caller knows from the spectrum's onset count.
    pub fn finish(mut self, one_onset: bool) -> LevelStats {
        if self.in_block > 0 {
            self.blocks.push(self.block_max);
        }
        let envelope = held(&self.blocks);
        let samples = self.frames * self.channels as u64;
        let mean_square = if samples > 0 { self.sum_squares / samples as f64 } else { 0.0 };
        let peak = self.peak.iter().copied().fold(0.0f32, f32::max);
        let rms = power_db(mean_square);
        let crest = match (amp_db(f64::from(peak)), rms) {
            (Ok(p), Ok(r)) => Ok(p - r),
            _ => Err("silent"),
        };
        let silent = envelope.iter().filter(|e| **e < SILENT).count();
        let (attack_ms, tail) = if one_onset { attack_and_tail(&envelope) } else { (None, None) };
        LevelStats {
            sample_peak_dbfs: self.peak.iter().map(|p| amp_db(f64::from(*p))).collect(),
            true_peak_dbfs: amp_db(f64::from(self.true_peak.max(peak))),
            full_scale_samples: self.full_scale,
            rms_dbfs: rms,
            crest_db: crest,
            silent_share: if envelope.is_empty() { 1.0 } else { silent as f64 / envelope.len() as f64 },
            leading_silence_ms: envelope.iter().position(|e| *e >= SILENT).map(|i| i as f64).ok_or("silent"),
            attack_ms,
            tail,
            segment_rms_dbfs: self
                .segment_sums
                .iter()
                .map(|(sum, n)| if *n == 0 { Err("silent") } else { power_db(sum / (*n as f64 * self.channels as f64)) })
                .collect(),
        }
    }
}

/// Each block's peak held over the trailing `HOLD_BLOCKS` blocks.
fn held(blocks: &[f32]) -> Vec<f32> {
    (0..blocks.len())
        .map(|i| blocks[i.saturating_sub(HOLD_BLOCKS - 1)..=i].iter().copied().fold(0.0, f32::max))
        .collect()
}

/// Attack: 10% to 90% of the peak, rising. Tail: from the peak until the
/// envelope stays 60 dB below it, or "at least" when the region ends first.
fn attack_and_tail(envelope: &[f32]) -> (Option<u64>, Option<Tail>) {
    // The first block at the peak: the hold repeats it for 10 blocks.
    let (p, top) = envelope.iter().copied().enumerate().fold((0, 0.0f32), |best, (i, e)| if e > best.1 { (i, e) } else { best });
    if top < SILENT {
        return (None, None);
    }
    let rise = &envelope[..=p];
    let attack = match (rise.iter().position(|e| *e >= 0.1 * top), rise.iter().position(|e| *e >= 0.9 * top)) {
        (Some(a), Some(b)) => Some((b - a) as u64),
        _ => None,
    };
    let floor = top * 0.001;
    let last = envelope[p..].iter().rposition(|e| *e >= floor).unwrap_or(0);
    let tail = if p + last + 1 < envelope.len() { Tail::Ms(last as u64 + 1) } else { Tail::AtLeast((envelope.len() - p) as u64) };
    (attack, Some(tail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{interleave, sine};
    use std::f64::consts::PI;

    fn levels(rate: u32, channels: usize, samples: &[f32], one_onset: bool) -> LevelStats {
        let mut l = Levels::new(rate, channels, vec![]);
        for chunk in samples.chunks(1000 * channels) {
            l.push(chunk);
        }
        l.finish(one_onset)
    }

    #[test]
    fn a_sine_reads_its_peak_rms_and_crest() {
        let s = levels(44_100, 1, &sine(44_100, 1000.0, 1.0, 0.5), false);
        assert!((s.sample_peak_dbfs[0].unwrap() + 6.02).abs() < 0.05);
        assert!((s.rms_dbfs.unwrap() + 9.03).abs() < 0.05);
        assert!((s.crest_db.unwrap() - 3.01).abs() < 0.05);
        assert_eq!(s.full_scale_samples, 0);
    }

    #[test]
    fn the_true_peak_finds_what_falls_between_samples() {
        // A quarter-rate sine at 45 degrees: every sample is ±0.707, the wave
        // itself reaches 1.0.
        let x: Vec<f32> = (0..4410).map(|i| (PI / 2.0 * i as f64 + PI / 4.0).sin() as f32).collect();
        let s = levels(44_100, 1, &x, false);
        assert!((s.sample_peak_dbfs[0].unwrap() + 3.01).abs() < 0.05);
        assert!(s.true_peak_dbfs.unwrap().abs() < 0.5, "{:?}", s.true_peak_dbfs);
    }

    #[test]
    fn a_full_scale_square_counts_every_sample_and_gives_no_verdict() {
        let x: Vec<f32> = (0..1000).map(|i| if (i / 50) % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let s = levels(44_100, 2, &interleave(&x, &x), false);
        assert_eq!(s.full_scale_samples, 2000);
    }

    #[test]
    fn silence_reads_null_stats_with_reasons() {
        let s = levels(44_100, 1, &vec![0.0; 44_100], true);
        assert_eq!((s.rms_dbfs, s.crest_db, s.true_peak_dbfs), (Err("silent"), Err("silent"), Err("silent")));
        assert_eq!(s.sample_peak_dbfs, vec![Err("silent")]);
        assert_eq!((s.leading_silence_ms, s.silent_share), (Err("silent"), 1.0));
        assert_eq!((s.attack_ms, s.tail), (None, None));
    }

    #[test]
    fn leading_silence_is_measured_to_the_millisecond() {
        let mut x = vec![0.0f32; 4410];
        x.extend(sine(44_100, 440.0, 0.5, 0.5));
        let s = levels(44_100, 1, &x, false);
        assert_eq!(s.leading_silence_ms, Ok(100.0));
        assert!((s.silent_share - 100.0 / 600.0).abs() < 0.01, "{}", s.silent_share);
    }

    /// 20 ms linear fade-in, then a decay reaching -60 dB 500 ms after the
    /// peak. 48 kHz, so a 1 ms block is exactly 48 frames.
    fn hit(seconds: f64) -> Vec<f32> {
        let rate = 48_000.0;
        (0..(seconds * rate) as usize)
            .map(|i| {
                let t = i as f64 / rate;
                let env = if t < 0.02 { t / 0.02 } else { 10f64.powf(-3.0 * (t - 0.02) / 0.5) };
                (env * (2.0 * PI * 1000.0 * t).sin()) as f32
            })
            .collect()
    }

    #[test]
    fn one_hit_has_an_attack_and_a_tail() {
        let s = levels(48_000, 1, &hit(1.0), true);
        let attack = s.attack_ms.unwrap();
        assert!((14..=18).contains(&attack), "attack {attack}");
        // -60 dB at 520 ms, plus up to 9 ms of hold.
        let Some(Tail::Ms(tail)) = s.tail else { panic!("{:?}", s.tail) };
        assert!((495..=515).contains(&tail), "tail {tail}");
    }

    #[test]
    fn a_tail_cut_by_the_region_is_at_least() {
        // 300 blocks, the peak in block 20.
        let s = levels(48_000, 1, &hit(0.3), true);
        assert_eq!(s.tail, Some(Tail::AtLeast(280)));
    }

    #[test]
    fn without_one_onset_there_is_no_attack_or_tail() {
        let s = levels(48_000, 1, &hit(1.0), false);
        assert_eq!((s.attack_ms, s.tail), (None, None));
    }

    #[test]
    fn segments_get_their_own_rms() {
        let mut x = sine(1_000, 50.0, 1.0, 0.5);
        x.extend(vec![0.0; 1_000]);
        let mut l = Levels::new(1_000, 1, vec![(0, 1_000), (1_000, 2_000)]);
        l.push(&x);
        let s = l.finish(false);
        assert!((s.segment_rms_dbfs[0].unwrap() + 9.03).abs() < 0.1);
        assert_eq!(s.segment_rms_dbfs[1], Err("silent"));
    }
}
