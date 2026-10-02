#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyArity {
    /// The address alone identifies the request.
    None,
    /// The first n reply arguments are the key.
    Args(usize),
    /// Request args vary, reply echoes nothing. Must be serialized.
    Unkeyed,
    /// Not a known endpoint. Never guess.
    Unknown,
}

// Deliberately a literal, exhaustive match — no `starts_with` prefix guards.
// A prefix guard on e.g. "/live/track/get/" would silently assign Args(1) to
// any made-up suffix under that prefix, which is exactly the guessed arity
// this module exists to rule out. Every address the system relies on gets
// its own line here; everything else is Unknown.
pub fn key_arity(addr: &str) -> KeyArity {
    match addr {
        "/live/mixingpal/get/rack/chains_range" => KeyArity::Args(4),
        "/live/song/get/tempo"
        | "/live/song/get/is_playing"
        | "/live/song/get/scale_name"
        | "/live/song/get/num_tracks"
        | "/live/song/get/num_scenes"
        | "/live/view/get/selected_track"
        | "/live/view/get/selected_scene"
        | "/live/view/get/selected_clip"
        | "/live/view/get/selected_device"
        | "/live/master/get/volume"
        | "/live/master/get/panning"
        | "/live/master/get/name"
        | "/live/master/get/output_meter_level"
        | "/live/master/get/volume_db"
        // Bare count, no index.
        | "/live/return/get/num_returns"
        // Task 8's SINGLETON_SUBSCRIPTIONS arrive as start_listen pushes at
        // these same addresses; still keyless, one value, no index.
        | "/live/song/get/root_note"
        | "/live/song/get/loop"
        | "/live/song/get/loop_start"
        | "/live/song/get/loop_length"
        | "/live/song/get/signature_numerator"
        | "/live/song/get/signature_denominator"
        | "/live/song/get/beat"
        // The wire-version handshake -- one int, no key. See
        // shared/wire-version.json and mixingpal/version.py.
        | "/live/mixingpal/get/version"
        // Cannot be subscribed: our handler is a plain one, like upstream's,
        // so there is no start_listen for it. Reply is a total followed by a
        // flat (name, time, name, time, ...) list, not a keyed value -- but
        // it is still one reply to one request, so the request itself is
        // keyless.
        | "/live/mixingpal/get/cue_points"
        // The set's stored id, name, and path -- three strings, no key.
        // See mixingpal/set_identity.py and the 2026-09-07 spec.
        | "/live/mixingpal/get/set_identity" => KeyArity::None,

        "/live/track/get/name"
        | "/live/track/get/mute"
        | "/live/track/get/solo"
        | "/live/track/get/volume"
        | "/live/track/get/volume_db"
        | "/live/track/get/panning"
        | "/live/track/get/output_meter_level"
        | "/live/track/get/clips/name"
        | "/live/track/get/arrangement_clips/name"
        // Reply is (track_index, is_midi) -- the track index alone is the
        // key, so every track's flag can be in flight at once, alongside
        // its clip names.
        | "/live/track/get/has_midi_input"
        // Reply is (track_index, *device_names) -- the track index alone is
        // the key, so every track's chain can be in flight at once.
        | "/live/track/get/devices/name"
        // Reply is (track_index, *flags), one per device in chain order --
        // the track index alone is the key, so every track's flags can be
        // in flight at once, alongside its names.
        | "/live/track/get/devices/can_have_chains"
        // (track) in, (track, total, digest) back. The digest is a
        // whole-timeline generation marker, so it is deliberately outside
        // the request key.
        | "/live/mixingpal/get/arrangement/fingerprint"
        | "/live/mixingpal/get/session/fingerprint"
        | "/live/mixingpal/get/device_chain/fingerprint"
        | "/live/return/get/volume"
        | "/live/return/get/panning"
        | "/live/return/get/name" => KeyArity::Args(1),

        "/live/track/get/send"
        | "/live/clip/get/notes"
        // The note count `get_clip_notes` sizes its windows from. Same key
        // as the notes themselves -- the reply echoes (track, clip).
        | "/live/clip/get/num_notes"
        | "/live/clip/get/length"
        // (track, clip) in, (track, clip, looping, start, end) back.
        | "/live/mixingpal/get/clip/loop_region"
        // (track, path) in, (track, path, name, num_parameters) back. One
        // address in place of the retired /live/device/get/name and
        // /live/device/get/num_parameters, so a bracketed parameter read
        // costs two round trips instead of four -- and unlike those two, it
        // resolves a path rather than a top-level index.
        | "/live/mixingpal/get/device/identity"
        | "/live/mixingpal/get/rack/fingerprint"
        // (track, start, span) out; (track, start, total, *records) back --
        // `arrangement_replies.py`'s own words are "track and start lead
        // because the client's request table keys on the leading arguments
        // of the request and the reply alike". `total` is the track's real
        // clip count, not an echo of `span`, so `span` cannot be in the key:
        // it would never match the reply's third value and no read would
        // ever resolve.
        | "/live/mixingpal/get/arrangement"
        | "/live/mixingpal/get/session/clips"
        | "/live/mixingpal/get/device_chain"
        // (track, index) in, (track, index, name, start_time, length) back.
        // Its own address rather than a span-1 page of the map, which is
        // keyed on (track, start): at index == start the two collide, the
        // identity read joins the page and takes its reply, and a page that
        // asked for 48 records is answered with one. Same reason
        // /live/mixingpal/get/device/identity exists.
        | "/live/mixingpal/get/arrangement/identity"
        // Same shape as the session clip's length and count -- (track,
        // index) in, echoed straight back with the value appended.
        | "/live/arrangement_clip/get/length"
        | "/live/arrangement_clip/get/num_notes" => KeyArity::Args(2),

        // The window ordinal the client stamped on the request, echoed
        // back. It is what makes two windows of ONE clip different keys, so
        // a window the caller gave up on cannot come back late and resolve
        // whichever window is waiting now -- the same protection the ranged
        // device addresses below get from echoing `start`. Upstream's
        // `/live/clip/get/notes` cannot offer it: its reply carries only
        // (track, clip).
        "/live/clip/get/notes_window"
        | "/live/device/get/parameter/value_string"
        | "/live/device/get/parameters/name_range"
        | "/live/device/get/parameters/value_string_range"
        // (track, path, start) echoed back, exactly like the ranged
        // parameter addresses. `span` is deliberately NOT in the key; see
        // the spec's Devices section on why that is safe here and what
        // closes it.
        | "/live/mixingpal/get/rack/chains"
        // Same role as the session clip's own window ordinal: what makes
        // two windows of ONE arrangement clip distinct keys, and what lets
        // `clip_notes::get_notes_at` share the decoder unmodified.
        | "/live/arrangement_clip/get/notes_window" => KeyArity::Args(3),

        "/live/song/get/track_data"
        | "/live/song/get/track_names"
        | "/live/track/get/mixer_data" => KeyArity::Unkeyed,

        _ => KeyArity::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_endpoint_the_design_uses() {
        // Each line is a load-bearing claim about how many leading reply args
        // are the key. A wrong entry cross-resolves queries between objects.
        let cases: &[(&str, KeyArity)] = &[
            ("/live/song/get/tempo", KeyArity::None),
            ("/live/song/get/is_playing", KeyArity::None),
            ("/live/song/get/scale_name", KeyArity::None),
            ("/live/song/get/num_tracks", KeyArity::None),
            ("/live/song/get/num_scenes", KeyArity::None),
            ("/live/view/get/selected_track", KeyArity::None),
            ("/live/view/get/selected_scene", KeyArity::None),
            ("/live/view/get/selected_clip", KeyArity::None),
            ("/live/view/get/selected_device", KeyArity::None),
            ("/live/master/get/volume", KeyArity::None),
            ("/live/master/get/panning", KeyArity::None),
            ("/live/master/get/name", KeyArity::None),
            ("/live/master/get/output_meter_level", KeyArity::None),
            ("/live/master/get/volume_db", KeyArity::None),
            ("/live/track/get/name", KeyArity::Args(1)),
            ("/live/track/get/mute", KeyArity::Args(1)),
            ("/live/track/get/solo", KeyArity::Args(1)),
            ("/live/track/get/volume", KeyArity::Args(1)),
            ("/live/track/get/volume_db", KeyArity::Args(1)),
            ("/live/track/get/panning", KeyArity::Args(1)),
            ("/live/track/get/output_meter_level", KeyArity::Args(1)),
            ("/live/track/get/clips/name", KeyArity::Args(1)),
            ("/live/track/get/arrangement_clips/name", KeyArity::Args(1)),
            ("/live/track/get/has_midi_input", KeyArity::Args(1)),
            ("/live/track/get/devices/name", KeyArity::Args(1)),
            // Racks. The rack listing echoes (track, path, start), exactly
            // as the ranged parameter addresses do -- the path travels as
            // ONE string argument, which is what keeps this a constant
            // rather than a function of the request.
            ("/live/track/get/devices/can_have_chains", KeyArity::Args(1)),
            ("/live/mixingpal/get/arrangement/fingerprint", KeyArity::Args(1)),
            ("/live/track/get/send", KeyArity::Args(2)),
            ("/live/return/get/volume", KeyArity::Args(1)),
            ("/live/return/get/panning", KeyArity::Args(1)),
            ("/live/return/get/name", KeyArity::Args(1)),
            ("/live/return/get/num_returns", KeyArity::None),
            ("/live/song/get/root_note", KeyArity::None),
            ("/live/song/get/loop", KeyArity::None),
            ("/live/song/get/loop_start", KeyArity::None),
            ("/live/song/get/loop_length", KeyArity::None),
            ("/live/song/get/signature_numerator", KeyArity::None),
            ("/live/song/get/signature_denominator", KeyArity::None),
            ("/live/song/get/beat", KeyArity::None),
            ("/live/mixingpal/get/version", KeyArity::None),
            ("/live/mixingpal/get/cue_points", KeyArity::None),
            ("/live/mixingpal/get/set_identity", KeyArity::None),
            ("/live/clip/get/notes", KeyArity::Args(2)),
            ("/live/clip/get/notes_window", KeyArity::Args(3)),
            ("/live/clip/get/num_notes", KeyArity::Args(2)),
            ("/live/clip/get/length", KeyArity::Args(2)),
            ("/live/mixingpal/get/clip/loop_region", KeyArity::Args(2)),
            // (track, path) in, (track, path, name, num_parameters) back. One
            // address in place of the retired /live/device/get/name and
            // /live/device/get/num_parameters, so a bracketed parameter read
            // costs two round trips instead of four -- and unlike those two, it
            // resolves a path rather than a top-level index.
            ("/live/mixingpal/get/device/identity", KeyArity::Args(2)),
            // (track, start, span) out; (track, start, total, *records) back
            // -- `span` cannot be in the key, because the reply's third
            // value is the real total, not an echo of it.
            ("/live/mixingpal/get/arrangement", KeyArity::Args(2)),
            // (track, index) in, (track, index, name, start_time, length)
            // back. A distinct address from the map, so an identity read
            // cannot join a map page and take its reply.
            ("/live/mixingpal/get/arrangement/identity", KeyArity::Args(2)),
            ("/live/arrangement_clip/get/length", KeyArity::Args(2)),
            ("/live/arrangement_clip/get/num_notes", KeyArity::Args(2)),
            ("/live/arrangement_clip/get/notes_window", KeyArity::Args(3)),
            ("/live/device/get/parameter/value_string", KeyArity::Args(3)),
            ("/live/device/get/parameters/name_range", KeyArity::Args(3)),
            (
                "/live/device/get/parameters/value_string_range",
                KeyArity::Args(3),
            ),
            // (track, path, start) echoed back, exactly like the ranged
            // parameter addresses. `span` is deliberately NOT in the key; see
            // the spec's Devices section on why that is safe here and what
            // closes it.
            ("/live/mixingpal/get/rack/chains", KeyArity::Args(3)),
            // Keyless: args vary between requests but the reply echoes nothing.
            ("/live/song/get/track_data", KeyArity::Unkeyed),
            ("/live/song/get/track_names", KeyArity::Unkeyed),
            ("/live/track/get/mixer_data", KeyArity::Unkeyed),
        ];
        for (addr, expected) in cases {
            assert_eq!(key_arity(addr), *expected, "wrong arity for {addr}");
        }
    }

    #[test]
    fn unknown_addresses_are_rejected_loudly() {
        // Defaulting an unknown address to a guess is how cross-resolution bugs
        // get in. Anything not in the map must be a hard failure.
        assert_eq!(key_arity("/live/track/get/invented"), KeyArity::Unknown);
    }
}
