//! Pitch by YIN on the mono sum, 30 Hz to 4 kHz. The difference function's
//! cross term comes from an FFT, so a frame costs three FFTs, not W².

use crate::tools::clip_notes::ableton_note_name;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

const LOWEST_HZ: f64 = 30.0;
const HIGHEST_HZ: f64 = 4000.0;
const THRESHOLD: f64 = 0.15;
/// A frame below -50 dBFS is not counted at all.
const QUIET: f64 = 1e-5;
const FRAMES_PER_SECOND: f64 = 50.0;
const SEMITONE_CENTS: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pitch {
    Steady(f64),
    Sweep { from_hz: f64, tail_hz: f64 },
    Unknown(&'static str),
}

enum Frame {
    Quiet,
    Voiced(f64),
    /// The lowest normalised difference found, for telling noise from a chord.
    Unvoiced(f64),
}

pub struct PitchTracker {
    rate: f64,
    window: usize,
    tau_max: usize,
    tau_min: usize,
    hop: usize,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    n: usize,
    buffer: Vec<f64>,
    a: Vec<Complex<f64>>,
    b: Vec<Complex<f64>>,
    frames: Vec<Frame>,
}

impl PitchTracker {
    pub fn new(rate: u32) -> Self {
        let r = f64::from(rate);
        let tau_max = (r / LOWEST_HZ).ceil() as usize;
        let window = tau_max;
        let n = (window + tau_max).next_power_of_two();
        let mut planner = FftPlanner::new();
        PitchTracker {
            rate: r,
            window,
            tau_max,
            tau_min: ((r / HIGHEST_HZ).floor() as usize).max(2),
            hop: (r / FRAMES_PER_SECOND).round() as usize,
            forward: planner.plan_fft_forward(n),
            inverse: planner.plan_fft_inverse(n),
            n,
            buffer: Vec::with_capacity(window + tau_max),
            a: vec![Complex::default(); n],
            b: vec![Complex::default(); n],
            frames: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[f32], channels: usize) {
        for frame in chunk.chunks_exact(channels) {
            self.buffer.push(frame.iter().map(|x| f64::from(*x)).sum::<f64>() / channels as f64);
            if self.buffer.len() == self.window + self.tau_max {
                self.analyse();
                self.buffer.drain(..self.hop);
            }
        }
    }

    fn analyse(&mut self) {
        let len = self.window + self.tau_max;
        let x = &self.buffer[..len];
        let mut energy = Vec::with_capacity(len + 1);
        energy.push(0.0f64);
        for v in x {
            energy.push(energy[energy.len() - 1] + v * v);
        }
        let e0 = energy[self.window];
        if e0 / (self.window as f64) < QUIET {
            self.frames.push(Frame::Quiet);
            return;
        }
        for (i, s) in self.a.iter_mut().enumerate() {
            *s = Complex::new(if i < self.window { x[i] } else { 0.0 }, 0.0);
        }
        for (i, s) in self.b.iter_mut().enumerate() {
            *s = Complex::new(if i < len { x[i] } else { 0.0 }, 0.0);
        }
        self.forward.process(&mut self.a);
        self.forward.process(&mut self.b);
        for (a, b) in self.a.iter_mut().zip(&self.b) {
            *a = a.conj() * b;
        }
        self.inverse.process(&mut self.a);
        let scale = 1.0 / self.n as f64;
        // Cumulative mean normalised difference, d'(0) = 1.
        let mut cmnd = vec![1.0f64; self.tau_max + 1];
        let mut running = 0.0;
        for tau in 1..=self.tau_max {
            let r = self.a[tau].re * scale;
            let d = (e0 + energy[tau + self.window] - energy[tau] - 2.0 * r).max(0.0);
            running += d;
            cmnd[tau] = if running > 0.0 { d * tau as f64 / running } else { 1.0 };
        }
        let mut tau = self.tau_min;
        while tau < self.tau_max {
            if cmnd[tau] < THRESHOLD {
                while tau + 1 < self.tau_max && cmnd[tau + 1] < cmnd[tau] {
                    tau += 1;
                }
                let (s0, s1, s2) = (cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]);
                let curve = s0 - 2.0 * s1 + s2;
                let shift = if curve.abs() > 1e-12 { (0.5 * (s0 - s2) / curve).clamp(-1.0, 1.0) } else { 0.0 };
                self.frames.push(Frame::Voiced(self.rate / (tau as f64 + shift)));
                return;
            }
            tau += 1;
        }
        let lowest = cmnd[self.tau_min..self.tau_max].iter().copied().fold(f64::INFINITY, f64::min);
        self.frames.push(Frame::Unvoiced(lowest));
    }

    /// Steady when voiced frames are most of the counted ones and their
    /// 10th-90th percentile spread is within a semitone. A sweep when the
    /// last quarter is steady and starts more than a semitone from the first.
    pub fn finish(self) -> Pitch {
        if self.frames.is_empty() {
            return Pitch::Unknown("region_too_short");
        }
        let voiced: Vec<f64> = self.frames.iter().filter_map(|f| if let Frame::Voiced(hz) = f { Some(*hz) } else { None }).collect();
        let mut unvoiced: Vec<f64> = self.frames.iter().filter_map(|f| if let Frame::Unvoiced(d) = f { Some(*d) } else { None }).collect();
        let counted = voiced.len() + unvoiced.len();
        if counted == 0 {
            return Pitch::Unknown("silent");
        }
        if voiced.len() * 2 <= counted {
            // A chord dips the difference function without reaching the
            // threshold; noise barely dips it at all.
            return Pitch::Unknown(if median(&mut unvoiced) < 0.35 { "polyphonic" } else { "noise" });
        }
        let cents = |v: &[f64]| v.iter().map(|hz| 1200.0 * (hz / 440.0).log2()).collect::<Vec<_>>();
        if spread(&cents(&voiced)) <= SEMITONE_CENTS {
            return Pitch::Steady(median(&mut voiced.clone()));
        }
        let q = (voiced.len() / 4).max(1);
        let (mut head, mut tail) = (voiced[..q].to_vec(), voiced[voiced.len() - q..].to_vec());
        let (from_hz, tail_hz) = (median(&mut head), median(&mut tail));
        if spread(&cents(&tail)) <= SEMITONE_CENTS && (1200.0 * (from_hz / tail_hz).log2()).abs() > SEMITONE_CENTS {
            return Pitch::Sweep { from_hz, tail_hz };
        }
        Pitch::Unknown("unstable")
    }
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn spread(cents: &[f64]) -> f64 {
    let mut s = cents.to_vec();
    s.sort_by(f64::total_cmp);
    let at = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
    at(0.9) - at(0.1)
}

/// Live's note name (440 Hz is A3) and how many cents off it.
pub fn note(hz: f64) -> (String, i64) {
    let midi = 69.0 + 12.0 * (hz / 440.0).log2();
    let nearest = midi.round();
    (ableton_note_name(nearest as i32), ((midi - nearest) * 100.0).round() as i64)
}

pub fn transposed(hz: f64, semitones: f64, cents: f64) -> f64 {
    hz * 2f64.powf((semitones + cents / 100.0) / 12.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{interleave, noise, sine};

    fn track(rate: u32, samples: &[f32], channels: usize) -> Pitch {
        let mut t = PitchTracker::new(rate);
        for chunk in samples.chunks(1001 * channels) {
            t.push(chunk, channels);
        }
        t.finish()
    }

    fn steady(p: Pitch) -> f64 {
        match p {
            Pitch::Steady(hz) => hz,
            other => panic!("{other:?}"),
        }
    }

    fn cents(a: f64, b: f64) -> f64 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn a_440_sine_reads_a3_within_five_cents_at_every_rate() {
        for rate in [44_100, 48_000, 96_000] {
            let hz = steady(track(rate, &sine(rate, 440.0, 1.0, 0.5), 1));
            assert!(cents(hz, 440.0).abs() < 5.0, "{rate}: {hz}");
            assert_eq!(note(hz).0, "A3");
        }
    }

    #[test]
    fn stereo_is_read_as_its_mono_sum() {
        let x = sine(44_100, 440.0, 0.5, 0.5);
        assert!(cents(steady(track(44_100, &interleave(&x, &x), 2)), 440.0).abs() < 5.0);
    }

    #[test]
    fn fifty_and_fifty_three_hertz_read_apart() {
        let a = steady(track(44_100, &sine(44_100, 50.0, 1.0, 0.5), 1));
        let b = steady(track(44_100, &sine(44_100, 53.0, 1.0, 0.5), 1));
        assert!((a - 50.0).abs() < 0.5 && (b - 53.0).abs() < 0.5, "{a} {b}");
        assert_ne!(note(a).0, note(b).0);
        assert_eq!((note(a).0.as_str(), note(b).0.as_str()), ("G0", "G#0"));
    }

    #[test]
    fn transpose_and_detune_move_the_note() {
        assert_eq!(note(transposed(440.0, 3.0, 0.0)).0, "C4");
        assert_eq!(note(transposed(440.0, -3.0, 0.0)).0, "F#3");
        // +60 cents crosses into A#3, 40 cents flat of it.
        assert_eq!(note(transposed(440.0, 0.0, 60.0)), ("A#3".to_string(), -40));
    }

    #[test]
    fn noise_has_no_pitch() {
        assert_eq!(track(44_100, &noise(44_100, 1.0, 0.5, 3), 1), Pitch::Unknown("noise"));
    }

    #[test]
    fn silence_and_a_tiny_region_say_why() {
        assert_eq!(track(44_100, &vec![0.0; 44_100], 1), Pitch::Unknown("silent"));
        assert_eq!(track(44_100, &vec![0.1; 100], 1), Pitch::Unknown("region_too_short"));
    }

    #[test]
    fn a_falling_sweep_reports_its_range_and_where_it_settles() {
        // An 808-style drop: 110 Hz falling to 55 Hz over 0.3 s, then held.
        let rate = 44_100.0;
        let mut phase = 0.0f64;
        let x: Vec<f32> = (0..(1.2 * rate) as usize)
            .map(|i| {
                let t = i as f64 / rate;
                let hz = if t < 0.3 { 110.0 * 0.5f64.powf(t / 0.3) } else { 55.0 };
                phase += 2.0 * std::f64::consts::PI * hz / rate;
                (0.5 * phase.sin()) as f32
            })
            .collect();
        match track(44_100, &x, 1) {
            Pitch::Sweep { from_hz, tail_hz } => {
                assert!(from_hz > 65.0, "{from_hz}");
                assert!(cents(tail_hz, 55.0).abs() < 10.0, "{tail_hz}");
            }
            other => panic!("{other:?}"),
        }
    }
}
