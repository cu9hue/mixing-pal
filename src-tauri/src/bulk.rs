use crate::deltas::{to_json, Delta};
use rosc::OscType;

/// Addresses `decode_track_data` re-emits, in the exact order
/// `abletonosc/song.py`'s `song_get_track_data` appends `track.*` values
/// when only `TRACK_DATA_PROPERTIES` (`track.name`, `track.mute`,
/// `track.solo`) is requested -- see `lib.rs`'s `TRACK_DATA_PROPERTIES` and
/// the brief's verified reply shape. Reused by `lib.rs`'s retained-eviction
/// call so the addresses a shrink must sweep can never drift out of sync
/// with the addresses a decode actually produces.
pub const TRACK_DATA_ADDRS: [&str; 3] = [
    "/live/track/get/name",
    "/live/track/get/mute",
    "/live/track/get/solo",
];

/// Addresses `decode_mixer_data` re-emits, in the order `copilot/mixer.py`'s
/// `mixer_data` handler appends `volume, panning` per track.
pub const MIXER_ADDRS: [&str; 2] = ["/live/track/get/volume", "/live/track/get/panning"];

/// Decodes a `track_data` reply -- `song.py` appends `name, mute, solo` per
/// track, in index order, with no echoed range -- into per-track deltas at
/// the addresses `applyDelta` already understands. `range` is the `(min,
/// max)` chunk this reply is presumed to answer (tracks `min..max`); the
/// caller is responsible for knowing that from the outstanding request,
/// since the reply itself carries no key to attribute it by.
pub fn decode_track_data(range: (u32, u32), args: &[OscType]) -> Vec<Delta> {
    decode_bulk(range, args, &TRACK_DATA_ADDRS, "track_data")
}

/// Decodes a `mixer_data` reply -- `volume, panning` per track, in index
/// order, no echoed range -- the same way `decode_track_data` does.
pub fn decode_mixer_data(range: (u32, u32), args: &[OscType]) -> Vec<Delta> {
    decode_bulk(range, args, &MIXER_ADDRS, "mixer_data")
}

/// Shared decode: `args` must be exactly `fields.len() * (max - min)`
/// values, `fields.len()` values per track in index order. Any other length
/// means the range attribution the caller supplied doesn't match what
/// actually came back -- trusting it anyway would silently write values
/// under the wrong track indices, which is exactly the class of
/// plausible-wrong-data this codebase exists to avoid. So a length
/// mismatch fails closed: log it and return nothing, rather than decode a
/// truncated prefix or guess.
fn decode_bulk(range: (u32, u32), args: &[OscType], fields: &[&str], label: &str) -> Vec<Delta> {
    let (min, max) = range;
    let count = max.saturating_sub(min) as usize;
    let stride = fields.len();
    let expected = stride * count;
    if args.len() != expected {
        eprintln!(
            "{label} reply length mismatch: range {min}..{max} implies {expected} values \
             ({stride} fields/track) but got {}; dropping rather than decode under a range \
             that doesn't match",
            args.len()
        );
        return Vec::new();
    }

    let mut out = Vec::with_capacity(expected);
    for i in 0..count {
        let index = min + i as u32;
        for (field, addr) in fields.iter().enumerate() {
            let value = to_json(&args[i * stride + field]);
            out.push(Delta {
                addr: (*addr).to_string(),
                args: vec![serde_json::json!(index), value],
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_two_track_track_data_reply_into_six_deltas() {
        let args = vec![
            OscType::String("Kick".into()),
            OscType::Bool(false),
            OscType::Bool(true),
            OscType::String("Bass".into()),
            OscType::Bool(true),
            OscType::Bool(false),
        ];
        // range (2, 4): tracks 2 and 3, so indices must be offset by 2, not
        // start from 0.
        let deltas = decode_track_data((2, 4), &args);
        assert_eq!(deltas.len(), 6);

        assert_eq!(deltas[0].addr, "/live/track/get/name");
        assert_eq!(deltas[0].args, vec![serde_json::json!(2), serde_json::json!("Kick")]);
        assert_eq!(deltas[1].addr, "/live/track/get/mute");
        assert_eq!(deltas[1].args, vec![serde_json::json!(2), serde_json::json!(false)]);
        assert_eq!(deltas[2].addr, "/live/track/get/solo");
        assert_eq!(deltas[2].args, vec![serde_json::json!(2), serde_json::json!(true)]);

        assert_eq!(deltas[3].addr, "/live/track/get/name");
        assert_eq!(deltas[3].args, vec![serde_json::json!(3), serde_json::json!("Bass")]);
        assert_eq!(deltas[4].addr, "/live/track/get/mute");
        assert_eq!(deltas[4].args, vec![serde_json::json!(3), serde_json::json!(true)]);
        assert_eq!(deltas[5].addr, "/live/track/get/solo");
        assert_eq!(deltas[5].args, vec![serde_json::json!(3), serde_json::json!(false)]);
    }

    #[test]
    fn decodes_a_mixer_data_reply_into_volume_and_panning_per_track() {
        let args = vec![
            OscType::Float(0.8),
            OscType::Float(-0.2),
            OscType::Float(0.5),
            OscType::Float(0.0),
        ];
        let deltas = decode_mixer_data((0, 2), &args);
        assert_eq!(deltas.len(), 4);
        assert_eq!(deltas[0].addr, "/live/track/get/volume");
        assert_eq!(deltas[0].args[0], serde_json::json!(0));
        assert_eq!(deltas[0].args[1], serde_json::json!(0.8));
        assert_eq!(deltas[1].addr, "/live/track/get/panning");
        assert_eq!(deltas[1].args[0], serde_json::json!(0));
        assert_eq!(deltas[1].args[1], serde_json::json!(-0.2));
        assert_eq!(deltas[2].addr, "/live/track/get/volume");
        assert_eq!(deltas[2].args[0], serde_json::json!(1));
        assert_eq!(deltas[3].addr, "/live/track/get/panning");
        assert_eq!(deltas[3].args[0], serde_json::json!(1));
        assert_eq!(deltas[3].args[1], serde_json::json!(0.0));
    }

    #[test]
    fn a_reply_whose_length_is_not_a_multiple_of_the_stride_fails_closed() {
        // range (0, 2) over track_data implies 6 values (3 fields * 2
        // tracks); 5 is neither that nor any other clean multiple. A wrong
        // length means the range attribution is unreliable, so this must
        // return nothing rather than decode a truncated or misaligned
        // prefix under indices that might be wrong.
        let args = vec![
            OscType::String("Kick".into()),
            OscType::Bool(false),
            OscType::Bool(true),
            OscType::String("Bass".into()),
            OscType::Bool(true),
        ];
        assert!(decode_track_data((0, 2), &args).is_empty());
    }

    #[test]
    fn a_mismatched_mixer_data_length_also_fails_closed() {
        let args = vec![OscType::Float(0.8)]; // range (0,2) implies 4 values
        assert!(decode_mixer_data((0, 2), &args).is_empty());
    }

    #[test]
    fn an_empty_reply_decodes_to_an_empty_vec() {
        assert!(decode_track_data((0, 0), &[]).is_empty());
        assert!(decode_mixer_data((0, 0), &[]).is_empty());
    }

    #[test]
    fn a_null_arg_stays_null_rather_than_becoming_a_default() {
        // Live can report Nil for a property it doesn't have a value for.
        // Coercing that to false/0 would be a lie about the actual track
        // state -- see the null-tolerance rule this mirrors in apply.ts.
        let args = vec![
            OscType::String("Kick".into()),
            OscType::Nil,
            OscType::Bool(false),
        ];
        let deltas = decode_track_data((0, 1), &args);
        assert_eq!(deltas[1].addr, "/live/track/get/mute");
        assert_eq!(deltas[1].args[1], serde_json::Value::Null);
    }
}
