//! get_sample's analysis of a 3-minute stereo file, pitch included: one cold
//! call, and two at once (the two analysis slots both busy).
//! `cargo bench --features bench --bench sample_analysis`

use criterion::{criterion_group, criterion_main, Criterion};
use mixing_pal_lib::bench_api::analyse;
use std::f64::consts::PI;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const RATE: u32 = 44_100;
const SECONDS: u64 = 180;

/// A bass note under a bright tone and some noise, as 16-bit stereo PCM.
fn three_minutes() -> PathBuf {
    let n = (SECONDS * u64::from(RATE)) as usize;
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut pcm = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f64 / f64::from(RATE);
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let noise = ((seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 0.05;
        let x = 0.4 * (2.0 * PI * 55.0 * t).sin() + 0.2 * (2.0 * PI * 1760.0 * t).sin() + noise;
        let s = ((x * 32767.0) as i16).to_le_bytes();
        pcm.extend_from_slice(&s);
        pcm.extend_from_slice(&s);
    }
    let path = std::env::temp_dir().join("mixingpal-bench-3min.wav");
    let data = pcm.len() as u32;
    let mut b = Vec::with_capacity(44 + pcm.len());
    for chunk in [&b"RIFF"[..], &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(),
        &2u16.to_le_bytes(), &RATE.to_le_bytes(), &(RATE * 4).to_le_bytes(), &4u16.to_le_bytes(), &16u16.to_le_bytes(),
        b"data", &data.to_le_bytes()] {
        b.extend_from_slice(chunk);
    }
    b.extend_from_slice(&pcm);
    std::fs::write(&path, b).unwrap();
    path
}

fn bench(c: &mut Criterion) {
    let path = three_minutes();
    let region = [(0, SECONDS * u64::from(RATE))];
    let once = || analyse(&path, &region, None, Instant::now() + Duration::from_secs(600)).unwrap();
    let mut g = c.benchmark_group("sample_analysis");
    g.sample_size(10).measurement_time(Duration::from_secs(60));
    g.bench_function("one_cold_call_3_min_stereo", |b| b.iter(once));
    g.bench_function("two_cold_calls_at_once", |b| {
        b.iter(|| {
            std::thread::scope(|s| {
                let a = s.spawn(once);
                let b2 = s.spawn(once);
                a.join().unwrap();
                b2.join().unwrap();
            })
        })
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
