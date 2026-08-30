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

/// The most notes one `/live/clip/get/notes` reply can carry. Exposed
/// because the caller bounds the note count it trusts against it -- see
/// `clip_notes::usable_note_estimate`.
pub fn max_notes_per_window() -> usize {
    budget_values() / VALUES_PER_NOTE
}

pub fn note_windows(clip_length_beats: f32, est_notes: usize) -> Vec<(f32, f32)> {
    let max_notes = max_notes_per_window();
    if est_notes <= max_notes || clip_length_beats <= 0.0 {
        return vec![(0.0, clip_length_beats.max(0.0))];
    }
    // Split by time, not by note index — the query form is time-ranged.
    let parts = est_notes.div_ceil(max_notes);
    let span = clip_length_beats / parts as f32;
    // Boundaries first, spans as their differences -- NOT a constant span
    // repeated. The consumer keeps a note when
    // `start >= window_start && start < window_start + span`, so window i's
    // computed end has to be bit-identical to window i+1's start; with one
    // shared span, `i as f32 * span` rounds and the two disagree by a few
    // ULPs, which is a crack a note can fall into and a silently short read.
    //
    // Differencing adjacent boundaries is exact here rather than merely
    // close: consecutive boundaries are always within a factor of two of
    // each other, so Sterbenz's lemma makes the f32 subtraction exact, and
    // an exact f32 span added to an exact f32 start reproduces the next
    // boundary exactly in f64.
    //
    // The last boundary is the clip length itself, not `parts as f32 *
    // span`, which overshoots (128.0 comes back as 128.00000381469727 at
    // three windows). Overshooting asks Live for notes past the end of the
    // clip; undershooting would drop the ones in the final fraction of a
    // beat.
    let bounds: Vec<f32> = (0..=parts)
        .map(|i| if i == parts { clip_length_beats } else { i as f32 * span })
        .collect();
    bounds.windows(2).map(|b| (b[0], b[1] - b[0])).collect()
}

pub fn param_windows(num_params: usize) -> Vec<(usize, usize)> {
    even_split(num_params, budget_values())
}

/// A parameter name or formatted value arrives as an OSC string, not a
/// 4-byte number: `4*ceil((len+1)/4) + 1` bytes. 64 covers a 59-character
/// name, longer than any stock Live parameter.
const BYTES_PER_PARAM_STRING: usize = 64;

/// Windows over a device's parameter list for the STRING-valued ranged
/// queries -- `/live/device/get/parameters/name_range` and
/// `.../value_string_range`.
///
/// `param_windows` above is not a substitute. It sizes with
/// `BYTES_PER_VALUE = 5`, correct for `value_range`'s floats but roughly
/// 13x too generous for strings: it would return a 1792-parameter window
/// serialising to about 30 KB, three times over `MAX_DATAGRAM` -- and past
/// the cap Live's `sendto` raises and the client receives nothing at all,
/// which is indistinguishable from Live being silent.
///
/// Derived from `MAX_DATAGRAM` rather than hardcoded, so it tracks the cap.
pub fn param_string_windows(num_params: usize) -> Vec<(usize, usize)> {
    even_split(num_params, (MAX_DATAGRAM - HEADER_SLACK) / BYTES_PER_PARAM_STRING)
}

/// Known ceiling: `track_data` takes only a track range, and clip values are
/// emitted per scene for every track in that range, so a chunk cannot be
/// split any finer than one track. When a *single* track's own per-scene
/// cost already exceeds the budget (very high scene counts), this still
/// returns single-track chunks that overflow `MAX_DATAGRAM` — there is no
/// way to shrink further within this query shape. The consumer will observe
/// that case as a reply that never arrives, not as an error from here.
///
/// `clip_props` is the count of *clip-valued* properties being requested
/// (`clip.*`, not `track.*`) — `abletonosc/song.py`'s `song_get_track_data`
/// only appends one value per scene per track for those; a `track.*`
/// property (e.g. `track.name`) appends exactly one value per track,
/// full stop, with no scene loop at all. Multiplying every property by
/// `num_scenes` regardless of which kind it is over-estimates a
/// `track.*`-only request (like the production `TRACK_DATA_PROPERTIES`)
/// by roughly `num_scenes`x, forcing far more chunks than the reply
/// actually needs — and more chunks is the only way the in-flight range
/// this module feeds (see `lib.rs`'s `TrackCounts`) can ever hold more
/// than one distinct range at a time, which is what makes the zombie-reply
/// misattribution race in the whole-branch review possible. Pass 0 when
/// none of the requested properties are `clip.*`.
pub fn track_chunks(
    num_tracks: usize,
    num_scenes: usize,
    props_per_track: usize,
    clip_props: usize,
) -> Vec<(usize, usize)> {
    // Per track: its own (track.*) properties, plus one clip value per
    // scene per clip-valued (clip.*) property. Scene count only enters in
    // via clip_props -- see the doc comment above.
    let values_per_track = props_per_track + clip_props * num_scenes.max(1);
    let tracks_per_chunk = (budget_values() / values_per_track.max(1)).max(1);
    even_split(num_tracks, tracks_per_chunk)
        .into_iter()
        .map(|(start, span)| (start, start + span))
        .collect()
}

/// Bytes one track costs in a `mixer_data` reply: `volume` and `panning` as
/// 4-byte floats, plus the formatted dB string, plus one type-tag byte per
/// value.
///
/// OSC strings are null-terminated and padded to a 4-byte boundary, so
/// "-12.5 dB" (8 characters plus the null) occupies 12. 16 is that with a
/// whole slot of headroom, covering everything Live produces here -- from
/// "-inf dB" to "-70.0 dB".
const MIXER_DB_STRING_BYTES: usize = 16;
pub(crate) const BYTES_PER_MIXER_TRACK: usize = 4 + 4 + MIXER_DB_STRING_BYTES + 3;

/// Chunks a `mixer_data` sweep by bytes.
///
/// Counts bytes directly rather than going through `budget_values()`, unlike
/// `track_chunks`: two of the three values per track are 4-byte floats and
/// the third is a padded string, so a flat 5-bytes-per-value estimate would
/// be wrong in both directions at once.
pub fn mixer_chunks(num_tracks: usize) -> Vec<(usize, usize)> {
    let per_chunk = ((MAX_DATAGRAM - HEADER_SLACK) / BYTES_PER_MIXER_TRACK).max(1);
    even_split(num_tracks, per_chunk)
        .into_iter()
        .map(|(start, span)| (start, start + span))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `mixingpal/rack_paths.py` fills its own reply window, so it carries a
    /// copy of this module's ceiling. A copy that drifts high makes Live's
    /// `sendto` raise and the client receives NOTHING -- silence, not
    /// truncation, and indistinguishable from a lost reply. Same tripwire
    /// pattern as `wire_version_matches_the_shared_manifest`.
    #[test]
    fn rack_byte_ceiling_matches_the_budget() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../remote-script/MixingPal/mixingpal/rack_paths.py"
        ))
        .expect("rack_paths.py is missing");
        let line = source
            .lines()
            .find_map(|l| l.strip_prefix("MAX_REPLY_BYTES = "))
            .expect("MAX_REPLY_BYTES is not declared on its own line");
        assert_eq!(
            line.trim().parse::<usize>().unwrap(),
            MAX_DATAGRAM - HEADER_SLACK
        );
    }

    /// `mixingpal/arrangement_replies.py` fills its own reply window too,
    /// so it carries a second copy of this module's ceiling -- for the
    /// arrangement map, the clip identity read, and the bounded cue-point
    /// reply. Same failure as `rack_byte_ceiling_matches_the_budget` above
    /// guards against, and pinned the same way: a copy that drifts high
    /// makes Live's `sendto` raise and the client receives NOTHING.
    #[test]
    fn arrangement_byte_ceiling_matches_the_budget() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../remote-script/MixingPal/mixingpal/arrangement_replies.py"
        ))
        .expect("arrangement_replies.py is missing");
        let line = source
            .lines()
            .find_map(|l| l.strip_prefix("MAX_REPLY_BYTES = "))
            .expect("MAX_REPLY_BYTES is not declared on its own line");
        assert_eq!(
            line.trim().parse::<usize>().unwrap(),
            MAX_DATAGRAM - HEADER_SLACK
        );
    }

    /// `src-tauri/src/tools/path.rs` and `rack_paths.py` each declare
    /// `MAX_PATH_LEN`, and the Python side is the one that decides whether a
    /// path the Rust side already accepted actually resolves. If Python's
    /// drifts LOWER than Rust's, the client happily sends a path Python then
    /// refuses; the handler raises inside Live and sends nothing, and the
    /// client reports `no_reply: the track or the path may not exist` --
    /// silent and permanent for any path past the drifted value, and
    /// indistinguishable from a bad path. `the_rack_listing_header_fits_...`
    /// above only bounds this value from ABOVE (a header computed from a
    /// smaller MAX_PATH_LEN still fits inside HEADER_SLACK), so it passes for
    /// any Python value <= 17 and would not have caught a drift to 5. This
    /// asserts equality, the way `rack_byte_ceiling_matches_the_budget` pins
    /// `MAX_REPLY_BYTES`.
    #[test]
    fn path_len_ceiling_matches_the_client_side() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../remote-script/MixingPal/mixingpal/rack_paths.py"
        ))
        .expect("rack_paths.py is missing");
        let line = source
            .lines()
            .find_map(|l| l.strip_prefix("MAX_PATH_LEN = "))
            .expect("MAX_PATH_LEN is not declared on its own line");
        assert_eq!(
            line.trim().parse::<usize>().unwrap(),
            crate::tools::path::MAX_PATH_LEN
        );
    }

    /// The rack listing's reply header has to fit inside `HEADER_SLACK`, or a
    /// full window overflows the datagram and Live sends nothing at all.
    ///
    /// `rack_paths.build_window` budgets only the RECORDS, against
    /// `MAX_REPLY_BYTES`. This asserts the rest of the message fits in what is
    /// left over. The path is the part that can grow, and the worst case is
    /// computable ONLY because `parse_path` caps a component at ten digits --
    /// before that cap existed, this header had no upper bound at all.
    #[test]
    fn the_rack_listing_header_fits_inside_the_slack() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../remote-script/MixingPal/mixingpal/rack_paths.py"
        ))
        .expect("rack_paths.py is missing");
        let max_path_len: usize = source
            .lines()
            .find_map(|l| l.strip_prefix("MAX_PATH_LEN = "))
            .expect("MAX_PATH_LEN is not declared on its own line")
            .trim()
            .parse()
            .unwrap();

        // An OSC string is padded to a multiple of 4 with at least one NUL.
        let osc_string = |len: usize| 4 * (len / 4 + 1);
        // Every component ten digits long, joined by dots.
        let worst_path = max_path_len * 10 + (max_path_len - 1);
        let address = osc_string("/live/mixingpal/get/rack/chains".len());
        // track, start, total_chains, can_have_chains.
        let ints = 4 * 4;
        // One tag byte per argument, plus the leading comma and its padding.
        let tags = 5 + 1 + 3;
        let header = address + osc_string(worst_path) + ints + tags;

        assert!(
            header <= HEADER_SLACK,
            "worst-case rack header is {header} bytes, past HEADER_SLACK ({HEADER_SLACK})"
        );
    }

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
    fn note_windows_tile_with_no_gap_at_the_exact_boundary_the_consumer_compares_on() {
        // `get_clip_notes` keeps a returned note only when
        // `start >= window_start && start < window_start + span`, both in
        // f64. So window i's computed END must be BIT-IDENTICAL to window
        // i+1's start, or a note landing between them belongs to no window
        // and is silently dropped from an otherwise complete-looking read.
        //
        // The existing tiling test allows 1e-3 of slack, which was harmless
        // while the only windows in production came from halving (exact
        // binary fractions). Sizing windows from a note count produces spans
        // like 128/3, where `i as f32 * span` rounds and the slack becomes a
        // real crack.
        //
        // The tail matters for the same reason: the last window must end
        // exactly at the clip length, or notes in the final fraction of a
        // beat are never requested at all.
        for parts in 2..40usize {
            let length = 128.0_f32;
            // est_notes chosen to force exactly `parts` windows.
            let est = (budget_values() / VALUES_PER_NOTE) * (parts - 1) + 1;
            let w = note_windows(length, est);
            assert_eq!(w.len(), parts, "expected {parts} windows for {est} notes");

            for pair in w.windows(2) {
                let (start_a, span_a) = pair[0];
                let (start_b, _) = pair[1];
                assert_eq!(
                    start_a as f64 + span_a as f64,
                    start_b as f64,
                    "gap or overlap between windows at {start_a} (+{span_a}) and {start_b}, \
                     with {parts} windows"
                );
            }

            let (last_start, last_span) = *w.last().unwrap();
            assert_eq!(
                last_start as f64 + last_span as f64,
                length as f64,
                "the last window must reach the end of the clip, with {parts} windows"
            );
        }
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
        // fewer tracks per chunk -- when the request actually includes a
        // clip.* property (clip_props = 1 here). Chunking by a fixed track
        // count is the bug this replaces.
        let few = track_chunks(50, 8, 4, 1);
        let many = track_chunks(50, 200, 4, 1);
        // Hand-computed against budget_values() == 1792:
        // few:  values_per_track = 4 + 1*8   = 12,  tracks_per_chunk = 1792/12  = 149 -> 1 chunk of 50.
        // many: values_per_track = 4 + 1*200 = 204, tracks_per_chunk = 1792/204 = 8   -> ceil(50/8) = 7 chunks.
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
        // already exceeds the datagram budget (2000 scenes, 4 props/track,
        // 1 of them clip-valued: values_per_track = 2004, 2004*5 +
        // HEADER_SLACK = 10276 > 9216). track_chunks has no way to split
        // below one track, so it emits single-track chunks that still
        // overflow. This pins that known ceiling as a documented fact, not
        // a silent gap. clip_props = 1 keeps the scene term meaningful --
        // this ceiling is specific to clip.*-bearing requests, not the
        // production track.*-only case (see the doc comment above).
        let chunks = track_chunks(50, 2000, 4, 1);
        assert_eq!(chunks.len(), 50);
        for (min, max) in &chunks {
            assert_eq!(max - min, 1, "expected single-track chunks at this scene count");
        }
        assert_eq!(chunks[0].0, 0);
        assert_eq!(chunks.last().unwrap().1, 50);
    }

    #[test]
    fn track_chunks_with_no_clip_props_ignores_scene_count() {
        // Regression for I3 (2026-08-16 whole-branch review): lib.rs's
        // production call requests only track.* properties
        // (TRACK_DATA_PROPERTIES), so clip_props = 0. A 50-track/200-scene
        // set must still fit in one chunk -- the old code multiplied every
        // property by num_scenes regardless of kind and demanded 7 chunks
        // for what is, on the wire, exactly 3 values per track.
        let chunks = track_chunks(50, 200, 3, 0);
        assert_eq!(chunks.len(), 1, "track.*-only requests must not scale with scene count");
        assert_eq!(chunks[0], (0, 50));
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
        assert_eq!(track_chunks(0, 8, 4, 1), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn track_chunks_tile_with_no_gap_or_overlap() {
        let chunks = track_chunks(50, 200, 4, 1);
        assert!(chunks.len() > 1);
        let mut expected_min = 0;
        for (min, max) in &chunks {
            assert_eq!(*min, expected_min);
            assert!(max > min);
            expected_min = *max;
        }
        assert_eq!(expected_min, 50);
    }

    #[test]
    fn a_real_set_still_fits_in_one_mixer_chunk() {
        // The producer's own sets, and anything like them, must not start
        // paying for round trips they don't need.
        assert_eq!(mixer_chunks(35), vec![(0, 35)]);
        assert_eq!(mixer_chunks(200), vec![(0, 200)]);
    }

    #[test]
    fn every_mixer_chunk_fits_inside_the_datagram_cap() {
        // The whole point. Past MAX_DATAGRAM the reply is not truncated -- it is
        // never sent, and silence is indistinguishable from Live being closed.
        let chunks = mixer_chunks(1000);
        assert!(chunks.len() > 1, "1000 tracks must page");
        for (min, max) in &chunks {
            let bytes = (max - min) * BYTES_PER_MIXER_TRACK + HEADER_SLACK;
            assert!(bytes <= MAX_DATAGRAM, "chunk {min}..{max} would be {bytes} bytes");
        }
    }

    #[test]
    fn mixer_chunks_tile_with_no_gap_or_overlap() {
        let chunks = mixer_chunks(1000);
        let mut expected = 0;
        for (min, max) in &chunks {
            assert_eq!(*min, expected);
            assert!(max > min);
            expected = *max;
        }
        assert_eq!(expected, 1000);
    }

    #[test]
    fn mixer_chunks_of_zero_tracks_is_empty() {
        assert_eq!(mixer_chunks(0), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn param_string_windows_page_at_the_string_budget_boundary() {
        // 64 bytes per parameter covers a 59-character name, longer than any
        // stock Live parameter. (9216 - 256) / 64 = 140.
        let max = 140;
        assert_eq!(param_string_windows(max).len(), 1);
        assert_eq!(param_string_windows(max + 1).len(), 2);
    }

    #[test]
    fn a_full_string_window_fits_inside_one_datagram() {
        // The claim the constant is making, asserted rather than trusted: a
        // full window of worst-case-length names must still fit, because past
        // MAX_DATAGRAM Live's sendto raises and we receive nothing at all.
        // Derived, not hardcoded: written as literals this assertion stops
        // testing anything the moment either constant moves.
        let (_, span) = param_string_windows(10_000)[0];
        assert!(
            span * BYTES_PER_PARAM_STRING + HEADER_SLACK <= MAX_DATAGRAM,
            "a full window overflows the datagram cap"
        );
    }

    #[test]
    fn param_string_windows_are_far_tighter_than_the_float_form() {
        // Guards the mistake this function exists to prevent: param_windows
        // sizes for 4-byte values and would hand back one window where the
        // string form needs many.
        assert!(param_string_windows(1000).len() > param_windows(1000).len());
    }

    #[test]
    fn param_string_windows_of_zero_params_is_empty() {
        assert_eq!(param_string_windows(0), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn param_string_windows_tile_with_no_gap_or_overlap() {
        let w = param_string_windows(1000);
        let mut expected_start = 0;
        for (start, span) in &w {
            assert_eq!(*start, expected_start);
            expected_start += span;
        }
        assert_eq!(expected_start, 1000);
    }
}
