//! Streams the frames of a played region out of an audio file. Packets are
//! decoded one at a time and only the region's frames reach the sink, so the
//! file is never held.

use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Instant, SystemTime};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_AAC, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Why a file could not be analysed. No variant carries text from the file
/// system or the decoder, so a path cannot reach a result through an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisError {
    FileMissing,
    FileInIcloud,
    UnsupportedFormat,
    UnsupportedChannels,
    DecodeFailed,
    RegionTooLong,
    AnalysisTimeout,
}

impl AnalysisError {
    pub fn code(self) -> &'static str {
        match self {
            AnalysisError::FileMissing => "file_missing",
            AnalysisError::FileInIcloud => "file_in_icloud",
            AnalysisError::UnsupportedFormat => "unsupported_format",
            AnalysisError::UnsupportedChannels => "unsupported_channels",
            AnalysisError::DecodeFailed => "decode_failed",
            AnalysisError::RegionTooLong => "region_too_long",
            AnalysisError::AnalysisTimeout => "analysis_timeout",
        }
    }
}

pub const MAX_REGION_SECONDS: u64 = 600;

/// Frames decoded before a region's start, so the decoder is settled when
/// the region begins. Covers one Vorbis long block.
const PREROLL_FRAMES: u64 = 4096;

/// macOS marks an iCloud file whose bytes are not on this disk as dataless.
/// Reading one starts a download, so it is refused before any read.
const SF_DATALESS: u32 = 0x4000_0000;

pub fn is_dataless(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// The file's size and modification time: the cache key's file state.
pub fn file_state(path: &Path) -> Result<(u64, SystemTime), AnalysisError> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => AnalysisError::FileMissing,
        _ => AnalysisError::DecodeFailed,
    })?;
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        if is_dataless(meta.st_flags()) {
            return Err(AnalysisError::FileInIcloud);
        }
    }
    let modified = meta.modified().map_err(|_| AnalysisError::DecodeFailed)?;
    Ok((meta.len(), modified))
}

fn hint_is_ogg(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("ogg") || e.eq_ignore_ascii_case("oga"))
}

/// The channel count of the first decoded packet, for a container that does
/// not state it (MP4 leaves it to the AAC stream). `stream` seeks before it
/// reads, so the packet used here is not lost.
fn decoded_channels(format: &mut dyn FormatReader, decoder: &mut dyn Decoder, track: u32) -> Result<usize, AnalysisError> {
    loop {
        let packet = format.next_packet().map_err(|_| AnalysisError::DecodeFailed)?;
        if packet.track_id() != track {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(d) => return Ok(d.spec().channels.count()),
            Err(Error::DecodeError(_)) => continue,
            Err(_) => return Err(AnalysisError::DecodeFailed),
        }
    }
}

pub struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track: u32,
    pub rate: u32,
    pub channels: usize,
    /// Container timestamps per audio frame: 1 unless the container counts
    /// in another time base.
    ts_per_frame: f64,
    /// Encoder delay frames the decoder leaves in, skipped here.
    delay: u64,
}

impl Source {
    pub fn open(path: &Path) -> Result<Source, AnalysisError> {
        file_state(path)?;
        let file = File::open(path).map_err(|e| match e.kind() {
            ErrorKind::NotFound => AnalysisError::FileMissing,
            _ => AnalysisError::DecodeFailed,
        })?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        // Gapless: encoder delay and padding are trimmed, so frame numbers
        // match the PCM Live plays. Not for Ogg: symphonia reads a start delay
        // from the first page that other decoders (ffmpeg, libvorbis) do not
        // trim, which would shift every frame.
        let ogg = hint_is_ogg(path);
        let options = FormatOptions { enable_gapless: !ogg, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &options, &MetadataOptions::default())
            .map_err(|_| AnalysisError::UnsupportedFormat)?;
        let mut format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .cloned()
            .ok_or(AnalysisError::UnsupportedFormat)?;
        let params = &track.codec_params;
        let rate = params.sample_rate.filter(|r| *r > 0).ok_or(AnalysisError::UnsupportedFormat)?;
        let ts_per_frame = params
            .time_base
            .filter(|tb| tb.numer > 0)
            .map_or(1.0, |tb| f64::from(tb.denom) / (f64::from(tb.numer) * f64::from(rate)));
        let mut decoder = symphonia::default::get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(|_| AnalysisError::UnsupportedFormat)?;
        let channels = match params.channels {
            Some(c) => c.count(),
            None => decoded_channels(&mut *format, &mut *decoder, track.id)?,
        };
        if !(1..=2).contains(&channels) {
            return Err(AnalysisError::UnsupportedChannels);
        }
        // symphonia trims no AAC priming. MP4 states it in an edit list that
        // symphonia does not read; 1024 frames is the AAC-LC encoder delay
        // ffmpeg and most encoders write (Apple's is 2112).
        let delay = if params.codec == CODEC_TYPE_AAC { u64::from(params.delay.unwrap_or(1024)) } else { 0 };
        Ok(Source { format, decoder, track: track.id, rate, channels, ts_per_frame, delay })
    }

    /// Sends each region's frames, in the order given, as interleaved
    /// chunks. Frames a seek lands on before the region's start are
    /// dropped, and decoding stops at its end. Returns the frames sent.
    pub fn stream(&mut self, regions: &[(u64, u64)], deadline: Instant, sink: &mut dyn FnMut(&[f32])) -> Result<u64, AnalysisError> {
        let total: u64 = regions.iter().map(|(a, b)| b.saturating_sub(*a)).sum();
        if total > MAX_REGION_SECONDS * u64::from(self.rate) {
            return Err(AnalysisError::RegionTooLong);
        }
        let mut buffer: Option<SampleBuffer<f32>> = None;
        let mut sent = 0u64;
        for &(start, end) in regions {
            if end <= start {
                continue;
            }
            // Seek early: a decoder's first packet after a reset can give no
            // frames (Vorbis overlaps each packet with the one before), and
            // the frames before `start` are dropped below anyway.
            let ts = ((start + self.delay).saturating_sub(PREROLL_FRAMES) as f64 * self.ts_per_frame).floor() as u64;
            if self.format.seek(SeekMode::Accurate, SeekTo::TimeStamp { ts, track_id: self.track }).is_err() {
                // Seeking past the end fails in some readers: nothing there.
                continue;
            }
            self.decoder.reset();
            loop {
                if Instant::now() >= deadline {
                    return Err(AnalysisError::AnalysisTimeout);
                }
                let packet = match self.format.next_packet() {
                    Ok(p) => p,
                    Err(Error::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => break,
                    Err(_) => return Err(AnalysisError::DecodeFailed),
                };
                if packet.track_id() != self.track {
                    continue;
                }
                // Signed: AAC priming frames sit before frame 0.
                let first = (packet.ts() as f64 / self.ts_per_frame).round() as i64 - self.delay as i64;
                let (start, end) = (start as i64, end as i64);
                if first >= end {
                    break;
                }
                let decoded = match self.decoder.decode(&packet) {
                    Ok(d) => d,
                    // One corrupt packet is skipped, as players do.
                    Err(Error::DecodeError(_)) => continue,
                    Err(_) => return Err(AnalysisError::DecodeFailed),
                };
                if decoded.spec().channels.count() != self.channels {
                    return Err(AnalysisError::DecodeFailed);
                }
                // HE-AAC decodes to its half-rate core: every frame number and
                // pitch would be off, so it is refused.
                if decoded.spec().rate != self.rate {
                    return Err(AnalysisError::UnsupportedFormat);
                }
                let frames = decoded.frames() as i64;
                if frames == 0 || first + frames <= start {
                    continue;
                }
                let needed = decoded.capacity() * self.channels;
                if buffer.as_ref().map_or(true, |b| b.capacity() < needed) {
                    buffer = Some(SampleBuffer::new(decoded.capacity() as u64, *decoded.spec()));
                }
                let b = buffer.as_mut().expect("set above");
                b.copy_interleaved_ref(decoded);
                let lo = (start - first).max(0) as usize;
                let hi = (end.min(first + frames) - first) as usize;
                sink(&b.samples()[lo * self.channels..hi * self.channels]);
                sent += (hi - lo) as u64;
                if first + frames >= end {
                    break;
                }
            }
        }
        Ok(sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::signals::{chirp, wav};
    use std::time::{Duration, Instant};

    fn later() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    fn read(path: &std::path::Path, regions: &[(u64, u64)]) -> Result<(Vec<f32>, u64), AnalysisError> {
        let mut source = Source::open(path)?;
        let mut out = Vec::new();
        let n = source.stream(regions, later(), &mut |chunk| out.extend_from_slice(chunk))?;
        Ok((out, n))
    }

    #[test]
    fn a_mid_file_region_decodes_exactly_its_frames_at_every_rate() {
        for rate in [44_100, 48_000, 96_000] {
            let signal = chirp(rate, 0.5);
            let path = wav(rate, 1, &signal);
            let (got, n) = read(&path, &[(5000, 9000)]).unwrap();
            assert_eq!((n, got.len()), (4000, 4000), "{rate}");
            for (g, want) in got.iter().zip(&signal[5000..9000]) {
                assert!((g - want).abs() < 1e-4, "{rate}: {g} vs {want}");
            }
        }
    }

    #[test]
    fn two_regions_arrive_in_playback_order() {
        // A looped arrangement clip plays [marker, loop_end) then [loop_start, ..).
        let signal = chirp(44_100, 0.5);
        let path = wav(44_100, 1, &signal);
        let (got, n) = read(&path, &[(15_000, 16_000), (1_000, 1_500)]).unwrap();
        assert_eq!(n, 1500);
        assert!((got[0] - signal[15_000]).abs() < 1e-4 && (got[1000] - signal[1_000]).abs() < 1e-4);
    }

    #[test]
    fn stereo_arrives_interleaved() {
        let left = chirp(44_100, 0.1);
        let right: Vec<f32> = left.iter().map(|x| -x).collect();
        let path = wav(44_100, 2, &crate::analysis::signals::interleave(&left, &right));
        let mut source = Source::open(&path).unwrap();
        assert_eq!((source.rate, source.channels), (44_100, 2));
        let mut out = Vec::new();
        source.stream(&[(100, 200)], later(), &mut |c| out.extend_from_slice(c)).unwrap();
        assert_eq!(out.len(), 200);
        assert!((out[0] - left[100]).abs() < 1e-4 && (out[1] + left[100]).abs() < 1e-4);
    }

    #[test]
    fn a_region_past_the_end_reads_what_exists() {
        let path = wav(44_100, 1, &chirp(44_100, 0.1));
        let (_, n) = read(&path, &[(4_310, 9_000)]).unwrap();
        assert_eq!(n, 100);
        assert_eq!(read(&path, &[(50_000, 60_000)]).map(|r| r.1), Ok(0));
    }

    #[test]
    fn a_missing_file_is_named_and_carries_no_path() {
        let e = Source::open(std::path::Path::new("/Users/someone/Secret/gone.wav")).err().unwrap();
        assert_eq!(e, AnalysisError::FileMissing);
        assert_eq!(e.code(), "file_missing");
    }

    #[test]
    fn the_dataless_flag_is_read() {
        assert!(is_dataless(0x4000_0000));
        assert!(is_dataless(0x4000_0020));
        assert!(!is_dataless(0x0000_0020));
        let path = wav(44_100, 1, &chirp(44_100, 0.01));
        assert!(file_state(&path).is_ok());
    }

    #[test]
    fn more_than_two_channels_are_refused() {
        let path = wav(44_100, 4, &vec![0.0; 400]);
        assert_eq!(Source::open(&path).err(), Some(AnalysisError::UnsupportedChannels));
    }

    #[test]
    fn a_file_that_is_not_audio_is_an_unsupported_format() {
        let path = wav(44_100, 1, &[0.0]).with_file_name("notes.txt");
        std::fs::write(&path, "not audio").unwrap();
        assert_eq!(Source::open(&path).err(), Some(AnalysisError::UnsupportedFormat));
    }

    #[test]
    fn a_region_over_ten_minutes_is_refused_before_decoding() {
        let path = wav(1_000, 1, &[0.0; 10]);
        let mut source = Source::open(&path).unwrap();
        let r = source.stream(&[(0, 600_001)], later(), &mut |_| {});
        assert_eq!(r, Err(AnalysisError::RegionTooLong));
    }

    #[test]
    fn a_passed_deadline_stops_with_a_timeout() {
        let path = wav(44_100, 1, &chirp(44_100, 0.5));
        let mut source = Source::open(&path).unwrap();
        let r = source.stream(&[(0, 20_000)], Instant::now(), &mut |_| {});
        assert_eq!(r, Err(AnalysisError::AnalysisTimeout));
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio").join(name)
    }

    /// The decoded region's offset against the reference, by the lag that
    /// correlates best within ±64 frames, and that correlation.
    fn best_lag(decoded: &[f32], reference: &[f32], start: usize) -> (i64, f64) {
        let mut best = (0i64, f64::MIN);
        for lag in -64i64..=64 {
            let (mut dot, mut a, mut b) = (0.0f64, 0.0f64, 0.0f64);
            for (i, d) in decoded.iter().enumerate() {
                let j = start as i64 + i as i64 + lag;
                if j < 0 || j as usize >= reference.len() {
                    continue;
                }
                let r = f64::from(reference[j as usize]);
                dot += f64::from(*d) * r;
                a += f64::from(*d).powi(2);
                b += r * r;
            }
            if a < 0.0 { continue; }
            let c = dot / (a * b).sqrt().max(1e-12);
            if c > best.1 {
                best = (lag, c);
            }
        }
        best
    }

    fn first_channel(path: &std::path::Path, region: (u64, u64)) -> Vec<f32> {
        let mut source = Source::open(path).unwrap();
        let ch = source.channels;
        let mut out = Vec::new();
        source.stream(&[region], later(), &mut |c| out.extend(c.iter().step_by(ch))).unwrap();
        out
    }

    #[test]
    fn he_aac_is_refused_rather_than_read_an_octave_off() {
        // symphonia decodes only HE-AAC's half-rate core, while the file
        // states the full rate.
        let mut source = Source::open(&fixture("he-aac-440.m4a")).unwrap();
        let r = source.stream(&[(0, 10_000)], later(), &mut |_| {});
        assert_eq!(r, Err(AnalysisError::UnsupportedFormat));
    }

    #[test]
    fn lossless_formats_decode_the_same_frames_mid_file() {
        let reference = chirp(22_050, 0.2);
        for name in ["chirp.flac", "chirp.aiff"] {
            let got = first_channel(&fixture(name), (1_500, 3_000));
            assert_eq!(got.len(), 1_500, "{name}");
            for (g, want) in got.iter().zip(&reference[1_500..3_000]) {
                assert!((g - want).abs() < 1e-3, "{name}: {g} vs {want}");
            }
        }
    }

    #[test]
    fn wav_24_bit_and_float_decode_the_same_frames() {
        let reference = chirp(22_050, 0.2);
        for name in ["chirp-s24.wav", "chirp-f32.wav"] {
            let got = first_channel(&fixture(name), (1_500, 3_000));
            assert_eq!(got.len(), 1_500, "{name}");
            for (g, want) in got.iter().zip(&reference[1_500..3_000]) {
                assert!((g - want).abs() < 1e-4, "{name}: {g} vs {want}");
            }
        }
    }

    #[test]
    fn lossy_formats_land_on_the_same_frames_mid_file() {
        // Encoder delay and padding must be honoured: the region lines up
        // with the source to within one frame.
        let reference = chirp(22_050, 0.2);
        // A region at frame 0 also checks that AAC priming sits before it.
        for name in ["chirp.mp3", "chirp.ogg", "chirp.m4a"] {
            for (start, end) in [(0, 1_000), (1_500, 3_000)] {
                let got = first_channel(&fixture(name), (start, end));
                assert_eq!(got.len() as u64, end - start, "{name}");
                let (lag, corr) = best_lag(&got, &reference, start as usize);
                assert!(lag.abs() <= 1 && corr > 0.9, "{name} at {start}: lag {lag}, correlation {corr:.3}");
            }
        }
    }
}
