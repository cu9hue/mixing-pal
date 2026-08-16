use crate::osc::arity::{key_arity, KeyArity};
use rosc::{OscMessage, OscType};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct Delta {
    pub addr: String,
    pub args: Vec<serde_json::Value>,
}

fn to_json(arg: &OscType) -> serde_json::Value {
    match arg {
        OscType::Int(i) => serde_json::json!(i),
        OscType::Long(i) => serde_json::json!(i),
        // `Value::from(f32)` widens by casting the raw bits to f64, which
        // keeps the f32 rounding error (0.9_f32 -> 0.8999999761581421) and
        // never equals a same-valued f64 literal. Round-tripping through
        // f32's shortest-decimal Display gives the f64 a human would expect.
        OscType::Float(f) => serde_json::json!(f.to_string().parse::<f64>().unwrap()),
        OscType::Double(f) => serde_json::json!(f),
        OscType::String(s) => serde_json::json!(s),
        OscType::Bool(b) => serde_json::json!(b),
        OscType::Nil => serde_json::Value::Null,
        other => serde_json::json!(format!("{other:?}")),
    }
}

/// Buffers observations and, every 250ms (see `run()`), hands back one Delta
/// per object — last value wins within a window.
///
/// Policy note on `/live/song/get/beat`: it is a high-frequency transport
/// event with `KeyArity::None`, so within a 250ms window this coalescer keeps
/// only the most recent beat and drops the rest. That is correct for a
/// position readout (the webview only ever needs "where are we now") and
/// deliberately wrong if anything downstream ever needs beat as a discrete
/// counter that must not miss values — such a consumer cannot use this path.
pub struct Coalescer {
    /// Keyed by address plus the endpoint's key args, so two tracks never
    /// collapse into one another but repeated meter reads for one track do.
    /// `KeyArity::Unknown` and `KeyArity::None` both contribute zero key
    /// args, which is intentional: an unknown address still coalesces
    /// per-address rather than being dropped or panicking.
    latest: HashMap<String, Delta>,
    order: Vec<String>,
    /// The last known value per key, same keying as `latest` but never
    /// cleared by `drain()`. A subscription's initial value (tempo,
    /// root_note, scale_name, ...) arrives once, at subscribe time, and
    /// never repeats on its own -- a frontend that attaches its listener
    /// after that burst was already drained and emitted would otherwise
    /// never see it. `snapshot()` lets a late subscriber catch up.
    retained: HashMap<String, Delta>,
    retained_order: Vec<String>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self {
            latest: HashMap::new(),
            order: Vec::new(),
            retained: HashMap::new(),
            retained_order: Vec::new(),
        }
    }

    pub fn observe(&mut self, msg: &OscMessage) {
        let n = match key_arity(&msg.addr) {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        let key_part: Vec<String> = msg
            .args
            .iter()
            .take(n)
            .map(|a| format!("{a:?}"))
            .collect();
        let key = format!("{}|{}", msg.addr, key_part.join(","));
        let delta = Delta {
            addr: msg.addr.clone(),
            args: msg.args.iter().map(to_json).collect(),
        };

        if !self.latest.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.latest.insert(key.clone(), delta.clone());

        // Same key, a separate map: bounded the same way `latest` is (one
        // entry per address+key), just never emptied by `drain()`.
        if !self.retained.contains_key(&key) {
            self.retained_order.push(key.clone());
        }
        self.retained.insert(key, delta);
    }

    /// Empties the buffer, returning deltas in first-seen order.
    pub fn drain(&mut self) -> Vec<Delta> {
        let out: Vec<Delta> = self
            .order
            .iter()
            .filter_map(|k| self.latest.get(k).cloned())
            .collect();
        self.latest.clear();
        self.order.clear();
        out
    }

    /// Every retained value, in first-seen order, unaffected by `drain()`.
    /// A late subscriber (the `snapshot` Tauri command) calls this to catch
    /// up on values that already arrived -- including a set's initial
    /// defaults, which are pushed once when `SINGLETON_SUBSCRIPTIONS` is
    /// sent and would otherwise be lost the moment they're drained by the
    /// emit loop before any webview listener exists.
    pub fn snapshot(&self) -> Vec<Delta> {
        self.retained_order
            .iter()
            .filter_map(|k| self.retained.get(k).cloned())
            .collect()
    }
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::{OscMessage, OscType};

    fn msg(addr: &str, args: Vec<OscType>) -> OscMessage {
        OscMessage { addr: addr.to_string(), args }
    }

    #[test]
    fn keeps_only_the_latest_value_per_object_within_a_window() {
        // A meter stream produces many observations per window. Only the last
        // one matters, and forwarding all of them is what floods the webview.
        let mut c = Coalescer::new();
        for level in [0.1_f32, 0.4, 0.9] {
            c.observe(&msg(
                "/live/track/get/output_meter_level",
                vec![OscType::Int(0), OscType::Float(level)],
            ));
        }
        let out = c.drain();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].args[1], serde_json::json!(0.9));
    }

    #[test]
    fn does_not_collapse_across_different_objects() {
        let mut c = Coalescer::new();
        c.observe(&msg(
            "/live/track/get/name",
            vec![OscType::Int(0), OscType::String("Kick".into())],
        ));
        c.observe(&msg(
            "/live/track/get/name",
            vec![OscType::Int(1), OscType::String("Bass".into())],
        ));
        assert_eq!(c.drain().len(), 2);
    }

    #[test]
    fn drain_empties_the_buffer() {
        let mut c = Coalescer::new();
        c.observe(&msg("/live/song/get/tempo", vec![OscType::Float(128.0)]));
        assert_eq!(c.drain().len(), 1);
        assert!(c.drain().is_empty());
    }

    #[test]
    fn snapshot_survives_drain_and_keeps_the_latest_value_per_key() {
        // A late subscriber (the `snapshot` command) must still see a
        // value that already went out and was drained by the emit loop --
        // most importantly a set's initial defaults (tempo, root_note,
        // scale_name, ...), which are pushed once at subscribe time and
        // never repeat on their own.
        let mut c = Coalescer::new();
        c.observe(&msg("/live/song/get/tempo", vec![OscType::Float(120.0)]));
        c.observe(&msg("/live/song/get/tempo", vec![OscType::Float(128.0)]));

        // The coalescer's own buffer drains and empties as usual.
        assert_eq!(c.drain().len(), 1);
        assert!(c.drain().is_empty());

        // The retained snapshot survived both drains and kept the latest
        // value, not the first.
        let snap = c.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].args[0], serde_json::json!(128.0));
    }

    #[test]
    fn snapshot_does_not_collapse_across_different_objects() {
        let mut c = Coalescer::new();
        c.observe(&msg(
            "/live/track/get/name",
            vec![OscType::Int(0), OscType::String("Kick".into())],
        ));
        c.observe(&msg(
            "/live/track/get/name",
            vec![OscType::Int(1), OscType::String("Bass".into())],
        ));
        c.drain();
        assert_eq!(c.snapshot().len(), 2);
    }
}
