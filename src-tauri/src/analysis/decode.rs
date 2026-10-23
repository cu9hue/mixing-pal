//! Streams the frames of a played region out of an audio file. Packets are
//! decoded one at a time and only the region's frames reach the sink, so the
//! file is never held.

use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Instant, SystemTime};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_AAC, CODEC_TYPE_ALAC, CODEC_TYPE_NULL};
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
    /// macOS refused access, such as a folder the producer did not allow.
    FileNotPermitted,
    UnsupportedFormat,
    UnsupportedChannels,
    DecodeFailed,
    RegionTooLong,
    AnalysisTimeout,
    /// The region starts after the file ends.
    FileShorterThanRegion,
}

impl AnalysisError {
    pub fn code(self) -> &'static str {
        match self {
            AnalysisError::FileMissing => "file_missing",
            AnalysisError::FileInIcloud => "file_in_icloud",
            AnalysisError::FileNotPermitted => "file_not_permitted",
            AnalysisError::UnsupportedFormat => "unsupported_format",
            AnalysisError::UnsupportedChannels => "unsupported_channels",
            AnalysisError::DecodeFailed => "decode_failed",
            AnalysisError::RegionTooLong => "region_too_long",
            AnalysisError::AnalysisTimeout => "analysis_timeout",
            AnalysisError::FileShorterThanRegion => "file_shorter_than_region",
        }
    }
}

pub const MAX_REGION_SECONDS: u64 = 600;
/// Ten minutes at 96 kHz. Work grows with the rate, so a 192 kHz region is
/// capped at five minutes to stay inside the analysis budget.
pub const MAX_REGION_FRAMES: u64 = MAX_REGION_SECONDS * 96_000;

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
        ErrorKind::PermissionDenied => AnalysisError::FileNotPermitted,
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

/// A moov larger than this is not read for its priming. A ten-minute AAC
/// file's is a few hundred KB.
const MAX_MOOV_BYTES: u64 = 16 << 20;

/// The AAC priming an MP4 file states, in frames: its first edit's media
/// time (ffmpeg writes one), else the iTunSMPB tag (Apple's encoder). symphonia
/// 0.5 reads neither.
fn mp4_priming(path: &Path, rate: u32) -> Option<u64> {
    let moov = read_moov(path)?;
    let trak = child(&moov, b"trak")?;
    if let Some(elst) = child(trak, b"edts").and_then(|e| child(e, b"elst")) {
        let mdhd = child(trak, b"mdia").and_then(|m| child(m, b"mdhd"))?;
        let timescale = u64::from(u32::from_be_bytes(mdhd.get(if mdhd[0] == 1 { 20..24 } else { 12..16 })?.try_into().ok()?));
        if let Some(time) = first_media_time(elst).filter(|_| timescale > 0) {
            return Some(time * u64::from(rate) / timescale);
        }
    }
    let meta = child(&moov, b"udta").and_then(|u| child(u, b"meta"))?;
    // meta is a full box in MP4 and a plain one in QuickTime files.
    let ilst = child(meta.get(4..)?, b"ilst").or_else(|| child(meta, b"ilst"))?;
    let priming = boxes(ilst).filter(|(k, _)| *k == b"----").find_map(|(_, tag)| {
        let name = child(tag, b"name")?;
        if name.get(4..)? != b"iTunSMPB" {
            return None;
        }
        // " 00000000 00000840 ..." : the second field is the priming, in hex.
        let text = std::str::from_utf8(child(tag, b"data")?.get(8..)?).ok()?;
        u64::from_str_radix(text.split_whitespace().nth(1)?, 16).ok()
    });
    priming
}

/// The first edit that is not an empty one: its start in the media's time scale.
fn first_media_time(elst: &[u8]) -> Option<u64> {
    let wide = elst.first()? == &1;
    let count = u32::from_be_bytes(elst.get(4..8)?.try_into().ok()?) as usize;
    let entry = if wide { 20 } else { 12 };
    (0..count).find_map(|i| {
        let at = 8 + i * entry;
        let time = if wide {
            i64::from_be_bytes(elst.get(at + 8..at + 16)?.try_into().ok()?)
        } else {
            i64::from(i32::from_be_bytes(elst.get(at + 4..at + 8)?.try_into().ok()?))
        };
        u64::try_from(time).ok()
    })
}

/// The body of the file's top-level moov box.
fn read_moov(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut at = 0u64;
    while at + 8 <= len {
        let mut head = [0u8; 16];
        file.seek(SeekFrom::Start(at)).ok()?;
        file.read_exact(&mut head[..8]).ok()?;
        let (mut size, mut header) = (u64::from(u32::from_be_bytes(head[..4].try_into().ok()?)), 8);
        if size == 1 {
            file.read_exact(&mut head[8..]).ok()?;
            (size, header) = (u64::from_be_bytes(head[8..].try_into().ok()?), 16);
        } else if size == 0 {
            size = len - at;
        }
        if size < header {
            return None;
        }
        if &head[4..8] == b"moov" {
            if size > MAX_MOOV_BYTES {
                return None;
            }
            let mut body = vec![0; (size - header) as usize];
            file.read_exact(&mut body).ok()?;
            return Some(body);
        }
        at += size;
    }
    None
}

/// The boxes laid end to end in `b`, as (type, body).
fn boxes(mut b: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    std::iter::from_fn(move || {
        let size = u32::from_be_bytes(b.get(..4)?.try_into().ok()?);
        let kind = b.get(4..8)?;
        let (header, size) = match size {
            1 => (16, usize::try_from(u64::from_be_bytes(b.get(8..16)?.try_into().ok()?)).ok()?),
            0 => (8, b.len()),
            s => (8, s as usize),
        };
        if size < header || size > b.len() {
            return None;
        }
        let (body, rest) = (&b[header..size], &b[size..]);
        b = rest;
        Some((kind, body))
    })
}

fn child<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(b).find(|(k, _)| k == kind).map(|(_, body)| body)
}

/// The rate and channel count of the first decoded packet, for what the
/// container does not state. `stream` seeks before it reads, so the packet
/// used here is not lost.
fn decoded_spec(format: &mut dyn FormatReader, decoder: &mut dyn Decoder, track: u32) -> Result<(u32, usize), AnalysisError> {
    loop {
        let packet = format.next_packet().map_err(|_| AnalysisError::DecodeFailed)?;
        if packet.track_id() != track {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(d) => return Ok((d.spec().rate, d.spec().channels.count())),
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
            ErrorKind::PermissionDenied => AnalysisError::FileNotPermitted,
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
        let mut decoder = symphonia::default::get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(|_| AnalysisError::UnsupportedFormat)?;
        // MP4 leaves AAC's channel count to the stream, and ALAC's rate to
        // ALAC's own header: the MP4 field cannot hold 96 kHz. AAC keeps its
        // stated rate, so `stream` can refuse HE-AAC's half-rate decoding.
        let alac = params.codec == CODEC_TYPE_ALAC;
        let decoded = if params.channels.is_none() || alac { Some(decoded_spec(&mut *format, &mut *decoder, track.id)?) } else { None };
        let rate = match decoded {
            Some((r, _)) if alac => r,
            _ => params.sample_rate.filter(|r| *r > 0).ok_or(AnalysisError::UnsupportedFormat)?,
        };
        let channels = match decoded {
            Some((_, c)) => c,
            None => params.channels.map_or(0, |c| c.count()),
        };
        let ts_per_frame = params
            .time_base
            .filter(|tb| tb.numer > 0)
            .map_or(1.0, |tb| f64::from(tb.denom) / (f64::from(tb.numer) * f64::from(rate)));
        if !(1..=2).contains(&channels) {
            return Err(AnalysisError::UnsupportedChannels);
        }
        // symphonia trims no AAC priming. 1024 frames is the AAC-LC encoder
        // delay most encoders write, for a file that does not state its own.
        let delay = if params.codec == CODEC_TYPE_AAC {
            params.delay.map(u64::from).or_else(|| mp4_priming(path, rate)).unwrap_or(1024)
        } else {
            0
        };
        Ok(Source { format, decoder, track: track.id, rate, channels, ts_per_frame, delay })
    }

    /// Sends each region's frames, in the order given, as interleaved
    /// chunks. Frames a seek lands on before the region's start are
    /// dropped, and decoding stops at its end. Returns the frames sent.
    pub fn stream(&mut self, regions: &[(u64, u64)], deadline: Instant, sink: &mut dyn FnMut(&[f32])) -> Result<u64, AnalysisError> {
        let total: u64 = regions.iter().map(|(a, b)| b.saturating_sub(*a)).sum();
        if total > MAX_REGION_SECONDS * u64::from(self.rate) || total > MAX_REGION_FRAMES {
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
    fn a_high_rate_region_is_capped_by_its_frames() {
        // Work grows with the rate: 192 kHz gets five minutes, not ten.
        let path = wav(192_000, 1, &[0.0; 10]);
        let mut source = Source::open(&path).unwrap();
        let r = source.stream(&[(0, 301 * 192_000)], later(), &mut |_| {});
        assert_eq!(r, Err(AnalysisError::RegionTooLong));
    }

    #[test]
    fn an_unreadable_file_says_permission_not_decoding() {
        use std::os::unix::fs::PermissionsExt;
        let path = wav(44_100, 1, &chirp(44_100, 0.01));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let e = Source::open(&path).err();
        assert_eq!(e.map(AnalysisError::code), Some("file_not_permitted"));
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
        for name in ["chirp.flac", "chirp.aiff", "chirp-alac.m4a"] {
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
        for name in ["chirp.mp3", "chirp.ogg", "chirp.m4a", "chirp-apple.m4a", "chirp-aac-at.m4a"] {
            for (start, end) in [(0, 1_000), (1_500, 3_000)] {
                let got = first_channel(&fixture(name), (start, end));
                assert_eq!(got.len() as u64, end - start, "{name}");
                let (lag, corr) = best_lag(&got, &reference, start as usize);
                assert!(lag.abs() <= 1 && corr > 0.9, "{name} at {start}: lag {lag}, correlation {corr:.3}");
            }
        }
    }
}
