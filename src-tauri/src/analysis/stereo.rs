//! Stereo correlation and side-to-mid power, over the whole band and below
//! 150 Hz, where a wide low end is usually a problem.

use super::Stat;
use std::f64::consts::PI;

const LOW_HZ: f64 = 150.0;
/// A mean square below -100 dBFS counts as silent.
const QUIET: f64 = 1e-10;

/// 2nd-order Butterworth low-pass (RBJ cookbook), direct form I. Two in a
/// row make a 4th-order Linkwitz-Riley: 24 dB down an octave above 150 Hz.
#[derive(Clone, Copy)]
struct LowPass {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl LowPass {
    fn new(rate: f64) -> Self {
        let w = 2.0 * PI * LOW_HZ / rate;
        let alpha = w.sin() / 2.0f64.sqrt();
        let (cos, a0) = (w.cos(), 1.0 + alpha);
        LowPass {
            b: [(1.0 - cos) / 2.0 / a0, (1.0 - cos) / a0, (1.0 - cos) / 2.0 / a0],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn step(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

#[derive(Default, Clone, Copy)]
struct Sums {
    ll: f64,
    rr: f64,
    lr: f64,
}

impl Sums {
    fn add(&mut self, l: f64, r: f64) {
        self.ll += l * l;
        self.rr += r * r;
        self.lr += l * r;
    }

    fn stats(&self, frames: u64) -> (Stat, Stat) {
        let quiet = QUIET * frames as f64;
        if self.ll < quiet || self.rr < quiet {
            return (Err("silent_channel"), Err("silent_channel"));
        }
        let correlation = (self.lr / (self.ll * self.rr).sqrt()).clamp(-1.0, 1.0);
        let mid = (self.ll + self.rr + 2.0 * self.lr) / 4.0;
        let side = (self.ll + self.rr - 2.0 * self.lr) / 4.0;
        let ratio = if mid < quiet {
            Err("no_mid")
        } else if side < quiet {
            Err("no_side")
        } else {
            Ok(10.0 * (side / mid).log10())
        };
        (Ok(correlation), ratio)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StereoStats {
    pub correlation: Stat,
    pub side_to_mid_db: Stat,
    pub low_correlation: Stat,
    pub low_side_to_mid_db: Stat,
}

pub struct Stereo {
    whole: Sums,
    low: Sums,
    /// Two stages for each channel.
    filters: [[LowPass; 2]; 2],
    frames: u64,
}

impl Stereo {
    pub fn new(rate: u32) -> Self {
        let f = LowPass::new(f64::from(rate));
        Stereo { whole: Sums::default(), low: Sums::default(), filters: [[f, f], [f, f]], frames: 0 }
    }

    pub fn push(&mut self, chunk: &[f32]) {
        for frame in chunk.chunks_exact(2) {
            let (l, r) = (f64::from(frame[0]), f64::from(frame[1]));
            self.whole.add(l, r);
            let [[l1, l2], [r1, r2]] = &mut self.filters;
            let (fl, fr) = (l2.step(l1.step(l)), r2.step(r1.step(r)));
            self.low.add(fl, fr);
            self.frames += 1;
        }
    }

    pub fn finish(self) -> StereoStats {
        let (correlation, side_to_mid_db) = self.whole.stats(self.frames);
        let (low_correlation, low_side_to_mid_db) = self.low.stats(self.frames);
        StereoStats { correlation, side_to_mid_db, low_correlation, low_side_to_mid_db }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{interleave, sine};

    fn stereo(left: &[f32], right: &[f32]) -> StereoStats {
        let mut s = Stereo::new(44_100);
        s.push(&interleave(left, right));
        s.finish()
    }

    #[test]
    fn identical_channels_correlate_fully_and_have_no_side() {
        let x = sine(44_100, 440.0, 0.5, 0.5);
        let s = stereo(&x, &x);
        assert!((s.correlation.unwrap() - 1.0).abs() < 1e-6);
        assert_eq!(s.side_to_mid_db, Err("no_side"));
    }

    #[test]
    fn anti_phase_reads_minus_one_and_has_no_mid() {
        let x = sine(44_100, 440.0, 0.5, 0.5);
        let y: Vec<f32> = x.iter().map(|v| -v).collect();
        let s = stereo(&x, &y);
        assert!((s.correlation.unwrap() + 1.0).abs() < 1e-6);
        assert_eq!(s.side_to_mid_db, Err("no_mid"));
    }

    #[test]
    fn one_silent_channel_reads_null() {
        let x = sine(44_100, 440.0, 0.5, 0.5);
        let s = stereo(&x, &vec![0.0; x.len()]);
        assert_eq!((s.correlation, s.side_to_mid_db), (Err("silent_channel"), Err("silent_channel")));
    }

    #[test]
    fn the_low_end_is_measured_on_its_own() {
        // 50 Hz in phase, 2 kHz in anti-phase: wide on top, mono below 150 Hz.
        let low = sine(44_100, 50.0, 1.0, 0.4);
        let high = sine(44_100, 2000.0, 1.0, 0.4);
        let left: Vec<f32> = low.iter().zip(&high).map(|(a, b)| a + b).collect();
        let right: Vec<f32> = low.iter().zip(&high).map(|(a, b)| a - b).collect();
        let s = stereo(&left, &right);
        assert!(s.correlation.unwrap().abs() < 0.1, "{:?}", s.correlation);
        assert!(s.low_correlation.unwrap() > 0.99, "{:?}", s.low_correlation);
        assert!(s.low_side_to_mid_db.unwrap() < -40.0, "{:?}", s.low_side_to_mid_db);
    }

    #[test]
    fn a_wide_part_an_octave_above_150_hz_stays_out_of_the_low_end() {
        // A mono sub under a louder anti-phase part at 300 Hz.
        let low = sine(44_100, 50.0, 1.0, 0.1);
        let high = sine(44_100, 300.0, 1.0, 0.5);
        let left: Vec<f32> = low.iter().zip(&high).map(|(a, b)| a + b).collect();
        let right: Vec<f32> = low.iter().zip(&high).map(|(a, b)| a - b).collect();
        let s = stereo(&left, &right);
        assert!(s.low_correlation.unwrap() > 0.7, "{:?}", s.low_correlation);
        assert!(s.low_side_to_mid_db.unwrap() < -8.0, "{:?}", s.low_side_to_mid_db);
    }
}
