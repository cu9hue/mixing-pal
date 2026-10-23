//! Spectral stats from a 2048-point Hann STFT, hop 512: band shares, the
//! centroid, and spectral-flux onsets. Power is summed over channels.

use super::{Segments, Stat};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::f64::consts::PI;
use std::sync::Arc;

pub const FFT: usize = 2048;
pub const HOP: usize = 512;
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

#[derive(Debug, Clone, PartialEq)]
pub struct SpectrumStats {
    pub band_shares: Result<[f64; 7], &'static str>,
    pub centroid_hz: Stat,
    pub onsets: usize,
    pub segment_centroid_hz: Vec<Stat>,
}

pub struct Spectrum {
    channels: usize,
    rate: f64,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    buffers: Vec<Vec<f32>>,
    scratch: Vec<Complex<f32>>,
    power: Vec<f64>,
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
        Spectrum {
            channels,
            rate: f64::from(rate),
            fft: FftPlanner::new().plan_fft_forward(FFT),
            window: (0..FFT).map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / FFT as f64).cos()) as f32).collect(),
            // Pre-filled so the first frame comes one hop in: a sound at the
            // region's start is in the first frame, not lost.
            buffers: vec![vec![0.0; FFT - HOP]; channels],
            scratch: vec![Complex::default(); FFT],
            power: vec![0.0; FFT / 2 + 1],
            previous: vec![0.0; FFT / 2 + 1],
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
        for frame in chunk.chunks_exact(self.channels) {
            for (buffer, x) in self.buffers.iter_mut().zip(frame) {
                buffer.push(*x);
            }
            self.position += 1;
            if self.buffers[0].len() == FFT {
                self.frame();
            }
        }
    }

    fn frame(&mut self) {
        self.power.iter_mut().for_each(|p| *p = 0.0);
        for c in 0..self.channels {
            for (s, (x, w)) in self.scratch.iter_mut().zip(self.buffers[c].iter().zip(&self.window)) {
                *s = Complex::new(x * w, 0.0);
            }
            self.fft.process(&mut self.scratch);
            for (p, s) in self.power.iter_mut().zip(&self.scratch) {
                *p += f64::from(s.norm_sqr());
            }
            self.buffers[c].drain(..HOP);
        }
        let bin_hz = self.rate / FFT as f64;
        let segment = self.segments.at(self.position.saturating_sub(FFT as u64 / 2));
        let mut flux = 0.0f32;
        for k in 1..self.power.len() {
            let (hz, p) = (k as f64 * bin_hz, self.power[k]);
            let band = BANDS.iter().position(|(_, top)| hz < *top).unwrap_or(BANDS.len() - 1);
            self.bands[band] += p;
            self.weighted += hz * p;
            self.total += p;
            if let Some(i) = segment {
                self.segment_sums[i].0 += hz * p;
                self.segment_sums[i].1 += p;
            }
            // Log-compressed magnitude, so a quiet onset still counts.
            let level = (100.0 * p.sqrt() * 2.0 / FFT as f64).ln_1p() as f32;
            flux += (level - self.previous[k]).max(0.0);
            self.previous[k] = level;
        }
        self.flux.push(flux);
    }

    pub fn finish(mut self) -> SpectrumStats {
        // The last partial hop is padded with silence, so a region shorter
        // than a hop still gets a frame.
        if self.buffers[0].len() > FFT - HOP {
            let missing = FFT - self.buffers[0].len();
            for b in &mut self.buffers {
                b.extend(std::iter::repeat(0.0).take(missing));
            }
            self.frame();
            // The padding cuts the sound off, which is not an onset.
            if self.flux.len() > 1 {
                self.flux.pop();
            }
        }
        let silent = self.total <= 1e-9;
        SpectrumStats {
            band_shares: if silent { Err("silent") } else { Ok(self.bands.map(|b| b / self.total)) },
            centroid_hz: if silent { Err("silent") } else { Ok(self.weighted / self.total) },
            onsets: onsets(&self.flux, HOP as f64 / self.rate),
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
    if top <= 0.0 {
        return 0;
    }
    let gap = (ONSET_GAP_SECONDS / hop_seconds).ceil() as usize;
    let mut last: Option<usize> = None;
    let mut count = 0;
    for (i, &f) in flux.iter().enumerate() {
        if f < 0.1 * top || flux[i.saturating_sub(3)..(i + 4).min(flux.len())].iter().any(|g| *g > f) {
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
    fn segments_get_their_own_centroid() {
        let mut x = sine(44_100, 500.0, 1.0, 0.5);
        x.extend(sine(44_100, 4000.0, 1.0, 0.5));
        let s = spectrum(44_100, &x, vec![(0, 44_100), (44_100, 88_200)]);
        let (a, b) = (s.segment_centroid_hz[0].unwrap(), s.segment_centroid_hz[1].unwrap());
        assert!((a - 500.0).abs() < 100.0 && (b - 4000.0).abs() < 300.0, "{a} {b}");
    }
}
