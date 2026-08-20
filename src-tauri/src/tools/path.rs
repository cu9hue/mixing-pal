use serde_json::Value;

/// The path from a track to one device: alternating device and chain
/// indices, always of odd length.
///
/// `[d]` is a top-level device. `[d, c, d]` is a device in chain `c` of the
/// rack at `d`. Every step into a rack costs a chain index and a device
/// index together, which is why the length is odd — an even-length path
/// names a chain, and a chain is not a thing this app reads parameters from.
///
/// Travels the wire as ONE dotted string, and that is the load-bearing
/// choice. A run of int arguments would make each address's key arity a
/// function of the request, and `osc/arity.rs` is a literal exhaustive match
/// precisely so that no arity is ever computed. One string argument keeps
/// the ranged addresses at a constant `Args(3)`; `RequestTable::key_of`
/// already encodes `OscType::String`, so single-flight keying, cancellation
/// and mis-attributed-reply rejection all work unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePath(Vec<u32>);

/// Four racks deep, and a guard rather than a product limit.
///
/// Path resolution runs inside Live's callback, on the thread that also has
/// to service audio. An unbounded walk driven by a malformed path is not a
/// cost this app gets to impose on a producer's session, so the refusal
/// happens here, before anything reaches the wire.
pub const MAX_PATH_LEN: usize = 9;

impl DevicePath {
    pub fn parse(raw: Option<&Value>) -> Option<Self> {
        let items = raw?.as_array()?;
        if items.is_empty() || items.len() > MAX_PATH_LEN || items.len() % 2 == 0 {
            return None;
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(element(item)?);
        }
        Some(DevicePath(out))
    }

    /// The dotted form `copilot/rack_paths.py::parse_path` reads back.
    pub fn wire(&self) -> String {
        self.0
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(".")
    }
}

/// One path index.
///
/// Mirrors `int_arg`'s float tolerance — real providers emit `1.0` for an
/// integer field — and adds the two rules a path index needs on top. A
/// negative index is refused because Python slices from the END on one, so
/// it would resolve silently to a real but different device. An index past
/// `i32::MAX` is refused because every index is narrowed to `i32`
/// downstream and `as i32` wraps rather than saturates.
fn element(v: &Value) -> Option<u32> {
    let n = match v.as_i64() {
        Some(i) => i,
        None => {
            let f = v.as_f64()?;
            if !f.is_finite() || f.fract() != 0.0 {
                return None;
            }
            f as i64
        }
    };
    (0..=i64::from(i32::MAX)).contains(&n).then_some(n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: serde_json::Value) -> Option<DevicePath> {
        DevicePath::parse(Some(&v))
    }

    #[test]
    fn a_path_names_a_device_so_its_length_is_always_odd() {
        // One device index, then a chain/device pair for every rack entered.
        assert!(parse(json!([0])).is_some());
        assert!(parse(json!([0, 4, 1])).is_some());
        assert!(parse(json!([0, 4, 0, 1, 0])).is_some());
        // An even length names a CHAIN, not a device. Accepting it would
        // leave the last index to be interpreted as one or the other, and
        // the two answers are different devices.
        assert!(parse(json!([0, 4])).is_none());
        assert!(parse(json!([0, 4, 0, 1])).is_none());
    }

    #[test]
    fn an_empty_path_is_refused_rather_than_defaulted_to_device_zero() {
        // Defaulting would answer a question about a device the model did
        // not name.
        assert!(parse(json!([])).is_none());
        assert!(DevicePath::parse(None).is_none());
    }

    #[test]
    fn the_depth_cap_is_enforced_on_the_client_side() {
        // Resolution runs inside Live's callback, on the thread that also
        // services audio. A malformed path must not buy an unbounded walk
        // there, so the refusal happens before anything reaches the wire.
        let ok: Vec<i64> = vec![0; MAX_PATH_LEN];
        let too_deep: Vec<i64> = vec![0; MAX_PATH_LEN + 2];
        assert!(parse(json!(ok)).is_some());
        assert!(parse(json!(too_deep)).is_none());
    }

    #[test]
    fn a_negative_or_fractional_index_is_refused() {
        // Python slices from the end on a negative index, so a negative
        // would silently resolve to a real but different device.
        assert!(parse(json!([-1])).is_none());
        assert!(parse(json!([0, -1, 0])).is_none());
        assert!(parse(json!([1.5])).is_none());
        assert!(parse(json!([f64::INFINITY])).is_none());
    }

    #[test]
    fn an_integral_float_is_accepted_because_providers_emit_them() {
        // Same tolerance int_arg already has, and for the same reason.
        assert_eq!(parse(json!([0.0, 4.0, 1.0])).unwrap().wire(), "0.4.1");
    }

    #[test]
    fn a_non_array_or_non_number_element_is_refused() {
        assert!(parse(json!(3)).is_none());
        assert!(parse(json!("0.4.1")).is_none());
        assert!(parse(json!({ "device": 0 })).is_none());
        assert!(parse(json!([true])).is_none());
        assert!(parse(json!(["0"])).is_none());
    }

    #[test]
    fn an_index_past_i32_is_refused_rather_than_wrapped() {
        // Every index is narrowed to i32 somewhere downstream, and `as i32`
        // WRAPS: 2^32 + 5 becomes 5, a real device that was never asked for.
        assert!(parse(json!([i64::from(i32::MAX)])).is_some());
        assert!(parse(json!([i64::from(i32::MAX) + 1])).is_none());
    }

    #[test]
    fn wire_renders_the_dotted_form_the_remote_script_parses() {
        assert_eq!(parse(json!([0])).unwrap().wire(), "0");
        assert_eq!(parse(json!([0, 4, 0, 1, 0])).unwrap().wire(), "0.4.0.1.0");
    }
}
