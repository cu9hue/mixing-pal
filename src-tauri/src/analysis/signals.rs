//! Test signals and a 16-bit PCM WAV writer. Test-only.

use std::f64::consts::PI;
use std::path::PathBuf;

pub fn sine(rate: u32, hz: f64, seconds: f64, amp: f64) -> Vec<f32> {
    let n = (seconds * f64::from(rate)).round() as usize;
    (0..n).map(|i| (amp * (2.0 * PI * hz * i as f64 / f64::from(rate)).sin()) as f32).collect()
}

/// 200 Hz rising 19,000 Hz per second at 0.5: the signal
/// `tests/fixtures/audio/make.sh` encodes.
pub fn chirp(rate: u32, seconds: f64) -> Vec<f32> {
    let n = (seconds * f64::from(rate)).round() as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / f64::from(rate);
            (0.5 * (2.0 * PI * (200.0 * t + 9500.0 * t * t)).sin()) as f32
        })
        .collect()
}

/// Uniform white noise from a fixed xorshift seed.
pub fn noise(rate: u32, seconds: f64, amp: f64, mut seed: u64) -> Vec<f32> {
    let n = (seconds * f64::from(rate)).round() as usize;
    (0..n)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (amp * ((seed >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0)) as f32
        })
        .collect()
}

pub fn interleave(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter().zip(right).flat_map(|(l, r)| [*l, *r]).collect()
}

/// Writes interleaved samples as 16-bit PCM to a new file in its own folder.
pub fn wav(rate: u32, channels: u16, samples: &[f32]) -> PathBuf {
    wav_in("signal", rate, channels, samples)
}

/// As `wav`, inside a folder of the given name, for privacy tests.
pub fn wav_in(folder: &str, rate: u32, channels: u16, samples: &[f32]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixingpal-{}", uuid::Uuid::new_v4())).join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("signal.wav");
    let data = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    b.extend_from_slice(&(channels * 2).to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    std::fs::write(&path, b).unwrap();
    path
}
