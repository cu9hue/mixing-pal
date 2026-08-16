/// net.inet.udp.maxdgram on macOS. Exceeding it makes sendto raise inside
/// Live and the client receives nothing at all — hard failure, not truncation.
pub const MAX_DATAGRAM: usize = 9216;

/// Leave room for the address string, type tag string, and echoed key args.
const HEADER_SLACK: usize = 256;

/// Every OSC int/float is 4 bytes of payload plus 1 byte of type tag.
const BYTES_PER_VALUE: usize = 5;

/// /live/clip/get/notes returns pitch, start_time, duration, velocity, mute.
const VALUES_PER_NOTE: usize = 5;

fn budget_values() -> usize {
    (MAX_DATAGRAM - HEADER_SLACK) / BYTES_PER_VALUE
}

fn even_split(total: usize, per_chunk: usize) -> Vec<(usize, usize)> {
    if total == 0 {
        return vec![];
    }
    let per_chunk = per_chunk.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while start < total {
        let span = per_chunk.min(total - start);
        out.push((start, span));
        start += span;
    }
    out
}

pub fn note_windows(clip_length_beats: f32, est_notes: usize) -> Vec<(f32, f32)> {
    let max_notes = budget_values() / VALUES_PER_NOTE;
    if est_notes <= max_notes || clip_length_beats <= 0.0 {
        return vec![(0.0, clip_length_beats.max(0.0))];
    }
    // Split by time, not by note index — the query form is time-ranged.
    let parts = est_notes.div_ceil(max_notes);
    let span = clip_length_beats / parts as f32;
    (0..parts)
        .map(|i| (i as f32 * span, span))
        .collect()
}

pub fn param_windows(num_params: usize) -> Vec<(usize, usize)> {
    even_split(num_params, budget_values())
}

/// Known ceiling: `track_data` takes only a track range, and clip values are
/// emitted per scene for every track in that range, so a chunk cannot be
/// split any finer than one track. When a *single* track's own per-scene
/// cost already exceeds the budget (very high scene counts), this still
/// returns single-track chunks that overflow `MAX_DATAGRAM` — there is no
/// way to shrink further within this query shape. The consumer will observe
/// that case as a reply that never arrives, not as an error from here.
pub fn track_chunks(
    num_tracks: usize,
    num_scenes: usize,
    props_per_track: usize,
) -> Vec<(usize, usize)> {
    // Per track: its own properties, plus one clip value per scene per
    // clip-valued property. Scene count dominates on real sets.
    let values_per_track = props_per_track + num_scenes.max(1);
    let tracks_per_chunk = (budget_values() / values_per_track.max(1)).max(1);
    even_split(num_tracks, tracks_per_chunk)
        .into_iter()
        .map(|(start, span)| (start, start + span))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_clip_needs_one_window() {
        let w = note_windows(16.0, 40);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0], (0.0, 16.0));
    }

    #[test]
    fn a_dense_clip_is_split_below_the_cap() {
        // 5 OSC values per note. 2000 notes cannot fit in 9216 bytes, so this
        // must page rather than produce one oversized request.
        let w = note_windows(64.0, 2000);
        assert!(w.len() > 1, "expected paging, got {} window(s)", w.len());
        // Windows must tile the clip with no gap and no overlap.
        assert_eq!(w[0].0, 0.0);
        for pair in w.windows(2) {
            let (start_a, span_a) = pair[0];
            let (start_b, _) = pair[1];
            assert!((start_a + span_a - start_b).abs() < 1e-3);
        }
        let (last_start, last_span) = *w.last().unwrap();
        assert!((last_start + last_span - 64.0).abs() < 1e-3);
    }

    #[test]
    fn a_rack_with_two_thousand_parameters_is_paged() {
        // NOTE: the brief's own draft used 1000 here, but budget_values() ==
        // (9216 - 256) / 5 == 1792, so 1000 params fit in a single window
        // and never exercise paging at all. 2000 is the smallest round
        // number that actually exceeds the real per-window budget, mirroring
        // how the notes test above uses 2000 for its dense case.
        let w = param_windows(2000);
        assert!(w.len() > 1);
        assert_eq!(w[0].0, 0);
        let covered: usize = w.iter().map(|(_, span)| span).sum();
        assert_eq!(covered, 2000);
    }

    #[test]
    fn param_windows_pages_exactly_at_the_real_budget_boundary() {
        // Pins the actual edge, derived from budget_values() itself, so a
        // future change to HEADER_SLACK or BYTES_PER_VALUE that moves the
        // real threshold gets caught here instead of passing silently.
        let max = budget_values();
        assert_eq!(param_windows(max).len(), 1);
        assert_eq!(param_windows(max + 1).len(), 2);
    }

    #[test]
    fn track_chunks_shrink_as_scene_count_grows() {
        // Clip segments are per scene, so a set with many scenes must take
        // fewer tracks per chunk. Chunking by a fixed track count is the bug
        // this replaces.
        let few = track_chunks(50, 8, 4);
        let many = track_chunks(50, 200, 4);
        // Hand-computed against budget_values() == 1792:
        // few:  values_per_track = 4 + 8   = 12,  tracks_per_chunk = 1792/12  = 149 -> 1 chunk of 50.
        // many: values_per_track = 4 + 200 = 204, tracks_per_chunk = 1792/204 = 8   -> ceil(50/8) = 7 chunks.
        // Exact counts, not just the inequality, so a regression that
        // preserves direction but breaks the packing arithmetic still fails.
        assert_eq!(few.len(), 1);
        assert_eq!(many.len(), 7);
        // Both must still cover every track exactly once.
        for chunks in [&few, &many] {
            assert_eq!(chunks[0].0, 0);
            assert_eq!(chunks.last().unwrap().1, 50);
        }
    }

    #[test]
    fn track_chunks_cannot_split_below_one_track_and_may_still_overflow() {
        // At very high scene counts, a single track's own per-scene cost
        // already exceeds the datagram budget (2000 scenes, 4 props/track:
        // values_per_track = 2004, 2004*5 + HEADER_SLACK = 10276 > 9216).
        // track_chunks has no way to split below one track, so it emits
        // single-track chunks that still overflow. This pins that known
        // ceiling as a documented fact, not a silent gap.
        let chunks = track_chunks(50, 2000, 4);
        assert_eq!(chunks.len(), 50);
        for (min, max) in &chunks {
            assert_eq!(max - min, 1, "expected single-track chunks at this scene count");
        }
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks.last().unwrap().1, 50);
    }

    // --- Boundary behaviour: zero inputs must not divide by zero, loop
    // forever, or (per the sibling task's negative-span bug) silently
    // return a bogus non-empty window. ---

    #[test]
    fn even_split_of_zero_total_is_empty() {
        assert_eq!(even_split(0, 10), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn even_split_of_zero_per_chunk_still_terminates_and_covers_the_total() {
        let out = even_split(5, 0);
        assert!(!out.is_empty());
        let covered: usize = out.iter().map(|(_, span)| span).sum();
        assert_eq!(covered, 5);
    }

    #[test]
    fn note_windows_of_a_zero_length_clip_is_a_single_empty_window() {
        let w = note_windows(0.0, 40);
        assert_eq!(w, vec![(0.0, 0.0)]);
    }

    #[test]
    fn note_windows_of_a_negative_length_clip_does_not_panic_or_overflow() {
        // The sibling task's bug: negative-span slicing silently returned
        // ~1000 elements instead of 0. Pin the clamp here too.
        let w = note_windows(-1.0, 40);
        assert_eq!(w, vec![(0.0, 0.0)]);
    }

    #[test]
    fn param_windows_of_zero_params_is_empty() {
        assert_eq!(param_windows(0), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn param_windows_tile_with_no_gap_or_overlap() {
        let w = param_windows(4000);
        assert!(w.len() > 1);
        let mut expected_start = 0;
        for (start, span) in &w {
            assert_eq!(*start, expected_start);
            expected_start += span;
        }
        assert_eq!(expected_start, 4000);
    }

    #[test]
    fn track_chunks_of_zero_tracks_is_empty() {
        assert_eq!(track_chunks(0, 8, 4), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn track_chunks_tile_with_no_gap_or_overlap() {
        let chunks = track_chunks(50, 200, 4);
        assert!(chunks.len() > 1);
        let mut expected_min = 0;
        for (min, max) in &chunks {
            assert_eq!(*min, expected_min);
            assert!(max > min);
            expected_min = *max;
        }
        assert_eq!(expected_min, 50);
    }
}
