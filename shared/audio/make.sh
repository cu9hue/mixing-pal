#!/bin/sh
# Regenerates the kick and bass the kick-bass eval reads: a 55 Hz (A0 in
# Live's naming) decaying kick and a 2 s 58.27 Hz (A#0) bass, a semitone
# apart. Mono FLAC (the kick at 22,050 Hz, the bass at 11,025 Hz),
# each under 20 KB. Needs ffmpeg.
set -e
cd "$(dirname "$0")"
ffmpeg -v error -y -f lavfi -i "aevalsrc=0.9*sin(2*PI*55*t)*exp(-6*t):s=22050:d=0.6" -sample_fmt s16 -c:a flac -compression_level 12 kick-a0.flac
ffmpeg -v error -y -f lavfi -i "aevalsrc=0.6*sin(2*PI*58.2705*t)*min(1\,(2-t)*10):s=11025:d=2" -sample_fmt s16 -c:a flac -compression_level 12 bass-asharp0.flac
