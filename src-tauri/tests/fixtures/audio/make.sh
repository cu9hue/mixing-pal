#!/bin/sh
# Regenerates the decode fixtures: 0.2 s of the chirp analysis/signals.rs
# computes (200 Hz rising 19,000 Hz per second, at 0.5), mono at 22,050 Hz.
# Each file stays under 20 KB. Needs ffmpeg with libmp3lame.
set -e
cd "$(dirname "$0")"
SRC="aevalsrc=0.5*sin(2*PI*(200*t+9500*t*t)):s=22050:d=0.2"
gen() { ffmpeg -v error -y -f lavfi -i "$SRC" "$@"; }
gen -c:a flac chirp.flac
gen -c:a pcm_s16be chirp.aiff
gen -c:a pcm_s24le chirp-s24.wav
gen -c:a pcm_f32le chirp-f32.wav
gen -c:a libmp3lame -b:a 64k chirp.mp3
# ffmpeg's own Vorbis encoder takes stereo only; both channels are the chirp.
gen -ac 2 -c:a vorbis -strict -2 chirp.ogg
gen -c:a aac -b:a 64k chirp.m4a
# Apple's AAC encoder primes 2112 frames, not 1024. afconvert states it in an
# iTunSMPB tag, ffmpeg's aac_at in an edit list. macOS only (AudioToolbox).
gen -c:a pcm_s16le apple-source.wav
afconvert -f m4af -d aac apple-source.wav chirp-apple.m4a
afconvert -f m4af -d alac apple-source.wav chirp-alac.m4a
rm apple-source.wav
gen -c:a aac_at -b:a 64k chirp-aac-at.m4a
# A video file: its first track is the video's, whose B-frames give it an
# edit list of its own, in the video's time scale.
ffmpeg -v error -y -f lavfi -i "testsrc=size=16x16:rate=25:duration=0.2" -f lavfi -i "$SRC" -map 0:v -map 1:a -c:v libx264 -bf 2 -c:a aac -b:a 64k chirp-video.mp4
# HE-AAC: symphonia decodes only its half-rate core. macOS only (AudioToolbox).
ffmpeg -v error -y -f lavfi -i "aevalsrc=0.5*sin(2*PI*440*t):s=44100:d=0.5" -c:a aac_at -profile:a 4 -b:a 32k he-aac-440.m4a
