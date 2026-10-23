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
