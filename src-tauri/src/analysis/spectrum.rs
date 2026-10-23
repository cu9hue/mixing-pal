//! Spectral stats: band shares and the centroid from a Hann STFT of 8192
//! points at 48 kHz, half overlapped; spectral-flux onsets from one of 2048
//! points at 48 kHz, hop a quarter of it. Both scale with the rate. Power is
//! summed over channels.

use super::{Segments, Stat};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::f64::consts::PI;
use std::sync::Arc;

/// The onset STFT's size: 2048 points at 44.1 and 48 kHz, about 46 ms,
/// scaled with the rate so a hit or a cut reads the same at every rate. Its
/// hop is a quarter of it.
pub fn onset_fft(rate: u32) -> usize {
    ((u64::from(rate) * 2048 / 48_000) as usize).next_power_of_two().max(256)
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
                self.record(self.position as i64 - self.long.size as i64);
            }
            if self.short.push(frame) {
                self.short.measure();
                self.onset(true);
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

    /// `start`: the stream position of the frame's first sample, below 0
    /// for the silence the first frame starts with. Each segment the frame
    /// overlaps gets the share of the window's mass that falls inside it, so
    /// one shorter than a hop still gets a centroid.
    fn record(&mut self, start: i64) {
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
        let (size, mass) = (self.long.size as i64, &self.long.mass);
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
        let held = self.long.buffers[0].len() as i64;
        if self.long.pad() {
            self.long.measure();
            self.record(self.position as i64 - held);
        }
        if self.short.pad() {
            self.short.measure();
            self.onset(true);
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

    #[test]
    fn segments_get_their_own_centroid() {
        let mut x = sine(44_100, 500.0, 1.0, 0.5);
        x.extend(sine(44_100, 4000.0, 1.0, 0.5));
        let s = spectrum(44_100, &x, vec![(0, 44_100), (44_100, 88_200)]);
        let (a, b) = (s.segment_centroid_hz[0].unwrap(), s.segment_centroid_hz[1].unwrap());
        assert!((a - 500.0).abs() < 100.0 && (b - 4000.0).abs() < 300.0, "{a} {b}");
    }
}
