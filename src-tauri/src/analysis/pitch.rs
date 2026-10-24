//! Pitch by YIN on the mono sum, 30 Hz to 4 kHz. The difference function's
//! cross term comes from an FFT, so a frame costs three FFTs, not W², and a
//! fourth when it finds a period.

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
/// Pitch needs at most 4 kHz, so a higher rate is averaged down to 48 kHz
/// or below first: YIN's cost grows with the square of the rate.
const MAX_RATE: f64 = 48_000.0;
/// A found period whose own frequency holds less of the frame's power than
/// this is the period several notes share, not a note: a major triad's
/// notes share a 55 Hz period that none of them plays. Chords measure under
/// 0.5%; a bass whose fundamental is 18 dB under its octave, about 5%.
const FUNDAMENTAL_SHARE: f64 = 0.02;
/// A note whose fundamental is weak or filtered out still has its 2nd to
/// 7th harmonics, each above this share of the Hann-windowed spectrum. The
/// period chord notes share misses some: a fifth's 55 Hz period has no 5th
/// harmonic, a triad's no 2nd or 3rd, an open E major's 41 Hz period no 7th.
/// Saw notes with their fundamental weak or gone measure 3.1% or more at the
/// weakest; saw chords on one harmonic series (A2 E3 A3, open E major,
/// C2 G2 C3 E3, C3 G3 E4) at most 0.45%, too near 0.5%.
const HARMONIC_SHARE: f64 = 0.01;

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
    /// A clear period with nothing at its frequency.
    Chord,
}

pub struct PitchTracker {
    /// After averaging down: the rate YIN runs at.
    rate: f64,
    step: usize,
    sum: f64,
    summed: usize,
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
    /// The frame's Hann-windowed spectrum, for the harmonic test.
    c: Vec<Complex<f64>>,
    hann: Vec<f64>,
    frames: Vec<Frame>,
}

impl PitchTracker {
    pub fn new(rate: u32) -> Self {
        let step = (f64::from(rate) / MAX_RATE).ceil().max(1.0) as usize;
        let r = f64::from(rate) / step as f64;
        let tau_max = (r / LOWEST_HZ).ceil() as usize;
        let window = tau_max;
        let n = (window + tau_max).next_power_of_two();
        let mut planner = FftPlanner::new();
        PitchTracker {
            rate: r,
            step,
            sum: 0.0,
            summed: 0,
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
            c: vec![Complex::default(); n],
            hann: (0..window + tau_max).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (window + tau_max) as f64).cos()).collect(),
            frames: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[f32], channels: usize) {
        for frame in chunk.chunks_exact(channels) {
            self.sum += frame.iter().map(|x| f64::from(*x)).sum::<f64>() / channels as f64;
            self.summed += 1;
            if self.summed < self.step {
                continue;
            }
            self.buffer.push(self.sum / self.step as f64);
            (self.sum, self.summed) = (0.0, 0);
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
                let hz = self.rate / (tau as f64 + shift);
                // `b` holds the frame's spectrum unwindowed, and its leakage
                // fills the gaps between a chord's harmonics.
                for (i, s) in self.c.iter_mut().enumerate() {
                    *s = Complex::new(if i < len { x[i] * self.hann[i] } else { 0.0 }, 0.0);
                }
                self.forward.process(&mut self.c);
                let power = |k: usize| self.c[k].norm_sqr();
                let top = self.n / 2 - 1;
                let total: f64 = (1..=top).map(power).sum();
                let share = |harmonic: f64| {
                    let bin = harmonic * hz * self.n as f64 / self.rate;
                    if bin + 1.0 > top as f64 {
                        return 0.0;
                    }
                    (((bin - 1.0).max(1.0) as usize)..=(bin + 1.0) as usize).map(power).sum::<f64>() / total
                };
                let note = share(1.0) >= FUNDAMENTAL_SHARE || (2..=7).all(|h| share(f64::from(h)) >= HARMONIC_SHARE);
                self.frames.push(if note { Frame::Voiced(hz) } else { Frame::Chord });
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
        let chords = self.frames.iter().filter(|f| matches!(f, Frame::Chord)).count();
        let counted = voiced.len() + unvoiced.len() + chords;
        if counted == 0 {
            return Pitch::Unknown("silent");
        }
        if voiced.len() * 2 <= counted {
            // A chord dips the difference function without reaching the
            // threshold (seventh chords measure about 0.3-0.36); noise barely
            // dips it (white about 0.9, brown about 0.7).
            let polyphonic = chords >= unvoiced.len() || median(&mut unvoiced) < 0.5;
            return Pitch::Unknown(if polyphonic { "polyphonic" } else { "noise" });
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
        for rate in [44_100, 48_000, 96_000, 192_000] {
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

    fn chord(hz: &[f64]) -> Vec<f32> {
        let parts: Vec<Vec<f32>> = hz.iter().map(|h| sine(44_100, *h, 1.0, 0.2)).collect();
        (0..44_100).map(|i| parts.iter().map(|p| p[i]).sum()).collect()
    }

    /// One second of a saw-like note: 8 harmonics falling as 1/k, the
    /// fundamental scaled by `fundamental`.
    fn saw(hz: f64, fundamental: f64) -> Vec<f32> {
        (0..44_100)
            .map(|i| {
                (1..=8)
                    .map(|k| {
                        let gain = if k == 1 { fundamental } else { 1.0 };
                        (gain * 0.2 / k as f64 * (2.0 * std::f64::consts::PI * hz * k as f64 * i as f64 / 44_100.0).sin()) as f32
                    })
                    .sum()
            })
            .collect()
    }

    #[test]
    fn a_chord_is_polyphonic_not_the_period_its_notes_share() {
        // A major triad's notes share a 55 Hz period; a fifth's too.
        for notes in [vec![220.0, 277.18, 329.63], vec![110.0, 164.81], vec![130.81, 164.81, 196.0, 246.94]] {
            assert_eq!(track(44_100, &chord(&notes), 1), Pitch::Unknown("polyphonic"), "{notes:?}");
        }
        let fifth: Vec<f32> = saw(110.0, 1.0).iter().zip(saw(164.81, 1.0)).map(|(a, b)| a + b).collect();
        assert_eq!(track(44_100, &fifth, 1), Pitch::Unknown("polyphonic"), "a fifth of saws");
    }

    #[test]
    fn a_chord_on_one_harmonic_series_is_polyphonic() {
        // Each chord's notes are harmonics of one low period: a power chord's
        // A2 E3 A3 of 55 Hz, an open E major's of 41.2 Hz, C2 G2 C3 E3 of
        // 32.7 Hz, C3 G3 E4 of 65.4 Hz.
        let chords = [
            vec![110.0, 164.81, 220.0],
            vec![82.41, 123.47, 164.81, 207.65, 246.94, 329.63],
            vec![65.41, 98.0, 130.81, 164.81],
            vec![130.81, 196.0, 329.63],
        ];
        for notes in chords {
            assert_eq!(track(44_100, &chord(&notes), 1), Pitch::Unknown("polyphonic"), "sines {notes:?}");
            let saws = notes.iter().map(|hz| saw(*hz, 1.0)).reduce(|a, b| a.iter().zip(b).map(|(x, y)| x + y).collect()).unwrap();
            assert_eq!(track(44_100, &saws, 1), Pitch::Unknown("polyphonic"), "saws {notes:?}");
        }
    }

    #[test]
    fn a_note_with_a_weak_or_missing_fundamental_is_still_one_note() {
        // A high-passed bass, a telephone-filtered voice.
        for (hz, fundamental) in [(110.0, 0.1), (110.0, 0.0), (220.0, 0.0), (55.0, 0.1)] {
            let p = track(44_100, &saw(hz, fundamental), 1);
            assert!(matches!(p, Pitch::Steady(f) if cents(f, hz).abs() < 10.0), "{hz} Hz, fundamental x{fundamental}: {p:?}");
        }
    }

    #[test]
    fn a_note_with_its_harmonics_is_still_one_note() {
        // A saw-like 55 Hz bass: the fundamental plus falling harmonics.
        let x: Vec<f32> = (0..44_100)
            .map(|i| (1..=8).map(|k| (0.4 / k as f64 * (2.0 * std::f64::consts::PI * 55.0 * k as f64 * i as f64 / 44_100.0).sin()) as f32).sum())
            .collect();
        assert!(cents(steady(track(44_100, &x, 1)), 55.0).abs() < 5.0);
    }

    #[test]
    fn a_wide_vibrato_is_unstable() {
        // 220 Hz swinging ±160 cents, three times a second.
        let mut phase = 0.0f64;
        let x: Vec<f32> = (0..88_200)
            .map(|i| {
                let hz = 220.0 * 2f64.powf(1.6 / 12.0 * (2.0 * std::f64::consts::PI * 3.0 * i as f64 / 44_100.0).sin());
                phase += 2.0 * std::f64::consts::PI * hz / 44_100.0;
                (0.5 * phase.sin()) as f32
            })
            .collect();
        assert_eq!(track(44_100, &x, 1), Pitch::Unknown("unstable"));
    }
}
