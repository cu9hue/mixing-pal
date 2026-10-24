//! Spectral stats: band shares and the centroid from a Hann STFT of 8192
//! points at 48 kHz, half overlapped; spectral-flux onsets and each
//! segment's centroid from one of 2048 points at 48 kHz, hop a quarter of it.
//! Both scale with the rate. Power is summed over channels.

use super::{Segments, Stat};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::f64::consts::PI;
use std::sync::Arc;

/// The onset STFT's size: the power of two nearest 46 ms of samples, so a
/// hit or a cut reads about the same at every rate: 2048 points at 44.1 and
/// 48 kHz, 32 ms at 8, 16 and 32 kHz (64 ms there merges clicks 62 ms
/// apart). Its hop is a quarter of it.
pub fn onset_fft(rate: u32) -> usize {
    let size = (u64::from(rate) * 2048 / 44_100) as usize;
    let above = size.next_power_of_two();
    (if above - size > size - above / 2 { above / 2 } else { above }).max(256)
}

/// Each band's upper edge in Hz; the last runs to Nyquist.
pub const BANDS: [(&str, f64); 7] = [
    ("sub", 60.0),
    ("bass", 250.0),
    ("low_mid", 500.0),
    ("mid", 2000.0),
    ("upper_mid", 4000.0),
    ("presence", 6000.0),
    ("air", f64::INFINITY),
];
/// Two onsets closer than this are one.
const ONSET_GAP_SECONDS: f64 = 0.05;
/// Flux below this is no onset at all: a steady tone wobbles near 0.01, a
/// hit at -60 dBFS reaches about 0.12. Without it the relative tests below
/// find "onsets" in a held note's wobble.
const ONSET_FLOOR: f32 = 0.05;

#[derive(Debug, Clone, PartialEq)]
pub struct SpectrumStats {
    pub band_shares: Result<[f64; 7], &'static str>,
    pub centroid_hz: Stat,
    pub onsets: usize,
    pub segment_centroid_hz: Vec<Stat>,
}

/// A Hann STFT over each channel, power summed over channels.
struct Stft {
    size: usize,
    hop: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    /// The window's running sum: `mass[i]` sums its first `i` values.
    mass: Vec<f64>,
    buffers: Vec<Vec<f32>>,
    scratch: Vec<Complex<f32>>,
    power: Vec<f64>,
}

impl Stft {
    fn new(size: usize, hop: usize, channels: usize) -> Self {
        let window: Vec<f32> = (0..size).map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / size as f64).cos()) as f32).collect();
        let mass = std::iter::once(0.0).chain(window.iter().scan(0.0, |sum, w| {
            *sum += f64::from(*w);
            Some(*sum)
        }));
        Stft {
            size,
            hop,
            fft: FftPlanner::new().plan_fft_forward(size),
            mass: mass.collect(),
            window,
            // Pre-filled so the first frame comes one hop in: a sound at the
            // region's start is in the first frame, not lost.
            buffers: vec![vec![0.0; size - hop]; channels],
            scratch: vec![Complex::default(); size],
            power: vec![0.0; size / 2 + 1],
        }
    }

    /// True when a frame is ready to measure.
    fn push(&mut self, frame: &[f32]) -> bool {
        for (buffer, x) in self.buffers.iter_mut().zip(frame) {
            buffer.push(*x);
        }
        self.buffers[0].len() == self.size
    }

    /// The last partial hop, padded with silence, so a region shorter than
    /// a hop still gets a frame. True when there was one.
    fn pad(&mut self) -> bool {
        if self.buffers[0].len() <= self.size - self.hop {
            return false;
        }
        let missing = self.size - self.buffers[0].len();
        for b in &mut self.buffers {
            b.extend(std::iter::repeat(0.0).take(missing));
        }
        true
    }

    /// Up to `size` interleaved frames as the whole buffer, zero-padded at
    /// the front.
    fn fill(&mut self, chunk: &[f32]) {
        let channels = self.buffers.len();
        let frames = chunk.len() / channels;
        for (c, buffer) in self.buffers.iter_mut().enumerate() {
            let mut b = vec![0.0; self.size.saturating_sub(frames)];
            b.extend(chunk.chunks_exact(channels).skip(frames.saturating_sub(self.size)).map(|f| f[c]));
            *buffer = b;
        }
    }

    /// The frame's power into `power`, then one hop on.
    fn measure(&mut self) {
        self.power.iter_mut().for_each(|p| *p = 0.0);
        for buffer in &mut self.buffers {
            for (s, (x, w)) in self.scratch.iter_mut().zip(buffer.iter().zip(&self.window)) {
                *s = Complex::new(x * w, 0.0);
            }
            self.fft.process(&mut self.scratch);
            for (p, s) in self.power.iter_mut().zip(&self.scratch) {
                *p += f64::from(s.norm_sqr());
            }
            buffer.drain(..self.hop);
        }
    }
}

pub struct Spectrum {
    rate: f64,
    /// Bands and centroid: about 170 ms, so 60 Hz splits sub from bass.
    long: Stft,
    /// Onsets: about 46 ms, hop about 12 ms.
    short: Stft,
    previous: Vec<f32>,
    bands: [f64; 7],
    weighted: f64,
    total: f64,
    flux: Vec<f32>,
    position: u64,
    segments: Segments,
    segment_sums: Vec<(f64, f64)>,
}

impl Spectrum {
    pub fn new(rate: u32, channels: usize, segments: Vec<(u64, u64)>) -> Self {
        let n = segments.len();
        // 8192 points at 48 kHz, scaled with the rate to keep the bins' width.
        let long = ((u64::from(rate) * 8192 / 48_000) as usize).next_power_of_two().max(2048);
        let short = onset_fft(rate);
        Spectrum {
            rate: f64::from(rate),
            long: Stft::new(long, long / 2, channels),
            short: Stft::new(short, short / 4, channels),
            previous: vec![0.0; short / 2 + 1],
            bands: [0.0; 7],
            weighted: 0.0,
            total: 0.0,
            flux: Vec::new(),
            position: 0,
            segments: Segments::new(segments),
            segment_sums: vec![(0.0, 0.0); n],
        }
    }

    pub fn push(&mut self, chunk: &[f32]) {
        for frame in chunk.chunks_exact(self.short.buffers.len()) {
            self.position += 1;
            if self.long.push(frame) {
                self.long.measure();
                self.record();
            }
            if self.short.push(frame) {
                self.short.measure();
                self.onset(true);
                self.credit(self.position as i64 - self.short.size as i64);
            }
        }
    }

    /// The frames just before the region, up to `onset_fft` of them: the first
    /// onset frame then compares against what was already sounding, so a
    /// region cut mid-note has no onset at its start. Nothing is measured
    /// from them.
    pub fn prime(&mut self, chunk: &[f32]) {
        self.short.fill(chunk);
        self.short.measure();
        self.onset(false);
    }

    fn record(&mut self) {
        let bin_hz = self.rate / self.long.size as f64;
        let (mut weighted, mut total) = (0.0, 0.0);
        for (k, &p) in self.long.power.iter().enumerate().skip(1) {
            let hz = k as f64 * bin_hz;
            let band = BANDS.iter().position(|(_, top)| hz < *top).unwrap_or(BANDS.len() - 1);
            self.bands[band] += p;
            weighted += hz * p;
            total += p;
        }
        self.weighted += weighted;
        self.total += total;
    }

    /// `start`: the stream position of the onset frame's first sample, below
    /// 0 for the silence or the priming the first frame starts with. Each
    /// segment the frame overlaps gets the share of the window's mass that
    /// falls inside it, so one shorter than a hop still gets a centroid. A
    /// long frame would reach 186 ms past a beat and carry its hit into the
    /// beat before; a 40 dB louder neighbour still dominates either one.
    fn credit(&mut self, start: i64) {
        let bin_hz = self.rate / self.short.size as f64;
        let (mut weighted, mut total) = (0.0, 0.0);
        for (k, &p) in self.short.power.iter().enumerate().skip(1) {
            weighted += k as f64 * bin_hz * p;
            total += p;
        }
        let (size, mass) = (self.short.size as i64, &self.short.mass);
        for (i, (a, b)) in self.segments.overlapping(start.max(0) as u64, (start + size).max(0) as u64) {
            let lo = (a as i64 - start).clamp(0, size) as usize;
            let hi = (b as i64 - start).clamp(0, size) as usize;
            let share = (mass[hi] - mass[lo]) / mass[size as usize];
            self.segment_sums[i].0 += share * weighted;
            self.segment_sums[i].1 += share * total;
        }
    }

    /// `keep`: false for a priming frame, which only sets `previous`.
    fn onset(&mut self, keep: bool) {
        let mut flux = 0.0f32;
        for (previous, &p) in self.previous.iter_mut().zip(&self.short.power).skip(1) {
            // Log-compressed magnitude, so a quiet onset still counts.
            let level = (100.0 * p.sqrt() * 2.0 / self.short.size as f64).ln_1p() as f32;
            flux += (level - *previous).max(0.0);
            *previous = level;
        }
        if keep {
            self.flux.push(flux);
        }
    }

    pub fn finish(mut self) -> SpectrumStats {
        if self.long.pad() {
            self.long.measure();
            self.record();
        }
        let held = self.short.buffers[0].len() as i64;
        if self.short.pad() {
            self.short.measure();
            self.onset(true);
            self.credit(self.position as i64 - held);
            // The padding cuts the sound off, which is not an onset.
            if self.flux.len() > 1 {
                self.flux.pop();
            }
        }
        let silent = self.total <= 1e-9;
        SpectrumStats {
            band_shares: if silent { Err("silent") } else { Ok(self.bands.map(|b| b / self.total)) },
            centroid_hz: if silent { Err("silent") } else { Ok(self.weighted / self.total) },
            onsets: onsets(&self.flux, self.short.hop as f64 / self.rate),
            segment_centroid_hz: self
                .segment_sums
                .iter()
                .map(|(w, t)| if *t <= 1e-9 { Err("silent") } else { Ok(w / t) })
                .collect(),
        }
    }
}

/// Peaks of the flux that are the largest within ±3 frames, above a tenth of
/// the largest peak and 1.5 times the mean within ±16 frames, and at least
/// 50 ms after the last onset.
fn onsets(flux: &[f32], hop_seconds: f64) -> usize {
    let top = flux.iter().copied().fold(0.0f32, f32::max);
    if top <= ONSET_FLOOR {
        return 0;
    }
    let gap = (ONSET_GAP_SECONDS / hop_seconds).ceil() as usize;
    let mut last: Option<usize> = None;
    let mut count = 0;
    for (i, &f) in flux.iter().enumerate() {
        if f < ONSET_FLOOR.max(0.1 * top) || flux[i.saturating_sub(3)..(i + 4).min(flux.len())].iter().any(|g| *g > f) {
            continue;
        }
        let around = &flux[i.saturating_sub(16)..(i + 17).min(flux.len())];
        if f < 1.5 * around.iter().sum::<f32>() / around.len() as f32 {
            continue;
        }
        if last.is_some_and(|l| i - l < gap) {
            continue;
        }
        last = Some(i);
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{noise, sine};

    fn spectrum(rate: u32, samples: &[f32], segments: Vec<(u64, u64)>) -> SpectrumStats {
        let mut s = Spectrum::new(rate, 1, segments);
        for chunk in samples.chunks(777) {
            s.push(chunk);
        }
        s.finish()
    }

    #[test]
    fn a_sine_sits_in_its_band_with_its_centroid() {
        let s = spectrum(44_100, &sine(44_100, 1000.0, 1.0, 0.5), vec![]);
        assert!(s.band_shares.unwrap()[3] > 0.95, "{:?}", s.band_shares);
        assert!((s.centroid_hz.unwrap() - 1000.0).abs() < 30.0, "{:?}", s.centroid_hz);
    }

    #[test]
    fn a_low_tone_lands_in_its_band_at_every_rate() {
        // A 55 Hz kick is sub; 70 Hz and 240 Hz are bass.
        for rate in [44_100, 96_000, 192_000] {
            for (hz, band) in [(50.0, 0), (55.0, 0), (70.0, 1), (240.0, 1)] {
                let shares = spectrum(rate, &sine(rate, hz, 1.0, 0.5), vec![]).band_shares.unwrap();
                assert!(shares[band] > 0.9, "{rate} Hz rate, {hz} Hz: {shares:?}");
            }
        }
    }

    #[test]
    fn white_noise_spreads_across_every_band() {
        let shares = spectrum(44_100, &noise(44_100, 1.0, 0.5, 7), vec![]).band_shares.unwrap();
        assert!(shares.iter().all(|s| *s > 0.001), "{shares:?}");
        assert!((shares.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        // Equal energy per Hz: the widest band holds the most.
        assert!(shares[6] > 0.5, "{shares:?}");
    }

    #[test]
    fn four_clicks_a_second_are_four_onsets_a_second() {
        let mut x = vec![0.0f32; 88_200];
        for k in 0..8 {
            x[k * 11_025] = 0.9;
        }
        assert_eq!(spectrum(44_100, &x, vec![]).onsets, 8);
    }

    #[test]
    fn eight_clicks_a_second_are_counted_at_every_rate() {
        for rate in [8_000, 11_025, 22_050, 44_100, 96_000, 192_000] {
            let mut x = vec![0.0f32; 2 * rate as usize];
            for k in 0..16 {
                x[k * rate as usize / 8] = 0.9;
            }
            assert_eq!(spectrum(rate, &x, vec![]).onsets, 16, "{rate}");
        }
    }

    #[test]
    fn sixteen_clicks_a_second_are_counted_at_every_rate() {
        // 62.5 ms apart: a 64 ms window would merge some.
        for rate in [8_000, 16_000, 32_000, 44_100, 48_000, 96_000] {
            let mut x = vec![0.0f32; 2 * rate as usize];
            for k in 0..32 {
                x[k * rate as usize / 16] = 0.9;
            }
            assert_eq!(spectrum(rate, &x, vec![]).onsets, 32, "{rate}");
        }
    }

    #[test]
    fn a_quiet_click_counts_at_every_rate() {
        // At -54 dBFS. A level scaled by 2048 points, not the frame's own
        // size, reads them 8 times quieter at 8 kHz.
        for rate in [8_000, 11_025, 22_050, 32_000, 44_100, 96_000] {
            let mut x = vec![0.0f32; 2 * rate as usize];
            for k in 0..8 {
                x[k * rate as usize / 4] = 0.002;
            }
            assert_eq!(spectrum(rate, &x, vec![]).onsets, 8, "{rate}");
        }
    }

    #[test]
    fn a_held_note_is_one_onset() {
        assert_eq!(spectrum(44_100, &sine(44_100, 220.0, 2.0, 0.5), vec![]).onsets, 1);
    }

    #[test]
    fn silence_has_no_spectrum_and_no_onsets() {
        let s = spectrum(44_100, &vec![0.0; 44_100], vec![]);
        assert_eq!((s.band_shares, s.centroid_hz, s.onsets), (Err("silent"), Err("silent"), 0));
    }

    #[test]
    fn a_region_shorter_than_a_hop_still_gets_a_frame() {
        let s = spectrum(44_100, &sine(44_100, 1000.0, 0.005, 0.5), vec![]);
        assert!(s.centroid_hz.is_ok(), "{:?}", s.centroid_hz);
    }

    #[test]
    fn a_segment_shorter_than_a_hop_has_a_centroid() {
        // 2.01 s in half-second steps ends in a 10 ms segment; one of 950
        // frames sits mid-stream.
        let x = noise(44_100, 2.01, 0.5, 9);
        let n = x.len() as u64;
        let tail: Vec<_> = (0..5).map(|k| (k * 22_050, ((k + 1) * 22_050).min(n))).collect();
        let mid = vec![(0, 22_050), (22_050, 23_000), (23_000, n)];
        for segments in [tail, mid] {
            let s = spectrum(44_100, &x, segments.clone());
            assert!(s.segment_centroid_hz.iter().all(Result::is_ok), "{segments:?}: {:?}", s.segment_centroid_hz);
        }
    }

    fn beats(rate: u32, n: usize, beat: f64) -> Vec<(u64, u64)> {
        let r = f64::from(rate);
        (0..8).map(|k| ((k as f64 * beat * r) as u64, (((k + 1) as f64 * beat * r) as u64).min(n as u64))).collect()
    }

    #[test]
    fn each_beat_of_a_kick_loop_reads_as_that_beat_alone() {
        // 120 BPM: a 60 Hz kick on every beat, a hat on every off-beat. The
        // kick straddles each segment's start.
        for rate in [44_100, 96_000] {
            let r = f64::from(rate);
            let n = (4.0 * r) as usize;
            let hat = noise(rate, 4.0, 0.5, 8);
            let x: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f64 / r;
                    let (kick, off) = (t % 0.5, (t + 0.25) % 0.5);
                    (0.8 * (2.0 * PI * 60.0 * kick).sin() * (-kick / 0.08).exp()) as f32
                        + 0.3 * hat[i] * (-off as f32 / 0.015).exp()
                })
                .collect();
            let segments = beats(rate, n, 0.5);
            let s = spectrum(rate, &x, segments.clone());
            for ((a, b), got) in segments.iter().zip(&s.segment_centroid_hz) {
                let alone = spectrum(rate, &x[*a as usize..*b as usize], vec![]).centroid_hz.unwrap();
                let got = *got.as_ref().unwrap();
                assert!((got / alone - 1.0).abs() < 0.2, "{rate} Hz rate, beat at {a}: {got} against {alone}");
            }
        }
    }

    #[test]
    fn a_gated_hit_on_every_beat_is_no_silent_beat() {
        // 30 ms of decaying noise on each beat at 120 BPM, then digital silence.
        for rate in [44_100, 48_000, 96_000] {
            let r = f64::from(rate);
            let n = (4.0 * r) as usize;
            let hit = noise(rate, 4.0, 0.5, 3);
            let x: Vec<f32> = (0..n)
                .map(|i| {
                    let t = (i as f64 / r) % 0.5;
                    if t < 0.03 { hit[i] * (-t as f32 / 0.01).exp() } else { 0.0 }
                })
                .collect();
            let s = spectrum(rate, &x, beats(rate, n, 0.5));
            assert!(s.segment_centroid_hz.iter().all(Result::is_ok), "{rate}: {:?}", s.segment_centroid_hz);
        }
    }

    #[test]
    fn segments_get_their_own_centroid() {
        let mut x = sine(44_100, 500.0, 1.0, 0.5);
        x.extend(sine(44_100, 4000.0, 1.0, 0.5));
        let s = spectrum(44_100, &x, vec![(0, 44_100), (44_100, 88_200)]);
        let (a, b) = (s.segment_centroid_hz[0].unwrap(), s.segment_centroid_hz[1].unwrap());
        assert!((a - 500.0).abs() < 100.0 && (b - 4000.0).abs() < 300.0, "{a} {b}");
    }
}
