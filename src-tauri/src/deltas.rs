use crate::osc::arity::{key_arity, KeyArity};
use rosc::{OscMessage, OscType};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
pub struct Delta {
    pub addr: String,
    pub args: Vec<serde_json::Value>,
}

/// One retained value plus when it was observed. `get_track_detail` is a
/// mirror read, so it reports the age rather than implying live truth.
#[derive(Debug, Clone)]
pub struct Retained {
    pub args: Vec<serde_json::Value>,
    pub observed_at: Instant,
}

pub(crate) fn to_json(arg: &OscType) -> serde_json::Value {
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
    /// When each `retained` entry was last observed. `Instant` rather than a
    /// wall clock because it cannot go backwards mid-session, and an age
    /// that goes negative would be reported to the model as freshness.
    retained_at: HashMap<String, Instant>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self {
            latest: HashMap::new(),
            order: Vec::new(),
            retained: HashMap::new(),
            retained_order: Vec::new(),
            retained_at: HashMap::new(),
        }
    }

    pub fn observe(&mut self, msg: &OscMessage) {
        let n = match key_arity(&msg.addr) {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        // Same rendering as observe_delta's, so one object has one key
        // whichever path it arrived by -- and so evict_tracks_at_or_beyond's
        // parse::<u32>() works on both.
        let key_part: Vec<String> = msg
            .args
            .iter()
            .take(n)
            .map(|a| to_json(a).to_string())
            .collect();
        let key = format!("{}|{}", msg.addr, key_part.join(","));
        let delta = Delta {
            addr: msg.addr.clone(),
            args: msg.args.iter().map(to_json).collect(),
        };
        self.ingest(key, delta);
    }

    /// Same coalescing as `observe`, for a `Delta` that was decoded from a
    /// bulk reply (see `bulk::decode_track_data`/`decode_mixer_data`)
    /// rather than read straight off the wire as an `OscMessage`. The key is
    /// computed from the delta's own (already JSON-converted) args instead
    /// of raw `OscType`s, since a decoded delta has no `OscMessage` to draw
    /// one from -- but every other behaviour (last-value-wins within a
    /// window, survival in `retained` across `drain()`) is identical, which
    /// is the point: the frontend and a reload's `snapshot()` cannot tell a
    /// bulk-decoded track delta apart from one that arrived any other way.
    pub fn observe_delta(&mut self, delta: Delta) {
        let n = match key_arity(&delta.addr) {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        let key_part: Vec<String> = delta.args.iter().take(n).map(|a| a.to_string()).collect();
        let key = format!("{}|{}", delta.addr, key_part.join(","));
        self.ingest(key, delta);
    }

    fn ingest(&mut self, key: String, delta: Delta) {
        if !self.latest.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.latest.insert(key.clone(), delta.clone());

        // Same key, a separate map: bounded the same way `latest` is (one
        // entry per address+key), just never emptied by `drain()`.
        if !self.retained.contains_key(&key) {
            self.retained_order.push(key.clone());
        }
        self.retained_at.insert(key.clone(), Instant::now());
        self.retained.insert(key, delta);
    }

    /// Removes `retained` (and, incidentally, any not-yet-drained `latest`)
    /// entries for track indices `>= num_tracks`, at any of `addrs`.
    ///
    /// Exists because `retained` never evicts on its own (see the module
    /// doc comment): before bulk decoding, that was harmless, since only
    /// song/view singletons and unkeyed bulk addresses ever landed in it,
    /// and the frontend ignored the unkeyed ones. Now that bulk replies are
    /// decoded into per-track deltas at real, keyed addresses (`/live/track/
    /// get/name` and friends), `retained` holds one entry per track index
    /// that ever existed in the session. Deleting a track in Live never
    /// tells this coalescer to forget it -- there is no "track removed"
    /// message, only a smaller `num_tracks` on the next poll -- so without
    /// this, a webview reload's `snapshot()` would resurrect rows for
    /// tracks no longer in the set.
    ///
    /// Called from `lib.rs` whenever `num_tracks` is observed to shrink,
    /// with the exact addresses `bulk::decode_track_data`/
    /// `decode_mixer_data` re-emit under (`TRACK_DATA_ADDRS` +
    /// `MIXER_ADDRS`), so this can never fall out of sync with what the
    /// decode step actually produces.
    pub fn evict_tracks_at_or_beyond(&mut self, addrs: &[&str], num_tracks: u32) {
        let is_stale = |key: &str| -> bool {
            for addr in addrs {
                if let Some(rest) = key.strip_prefix(addr) {
                    if let Some(index) = rest.strip_prefix('|') {
                        if let Ok(index) = index.parse::<u32>() {
                            return index >= num_tracks;
                        }
                    }
                }
            }
            false
        };

        self.retained_order.retain(|k| !is_stale(k));
        self.retained.retain(|k, _| !is_stale(k));
        self.retained_at.retain(|k, _| !is_stale(k));
        self.order.retain(|k| !is_stale(k));
        self.latest.retain(|k, _| !is_stale(k));
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

    /// The retained value for `addr` keyed by `key_args`, built the same way
    /// `observe`/`observe_delta` build theirs -- so a caller asks with the
    /// values it would have seen on the wire. Pass an empty slice for a
    /// `KeyArity::None` address.
    ///
    /// Reads `retained`, not `latest`, so a mirror read is unaffected by
    /// whether the emit loop happens to have drained recently.
    pub fn lookup(&self, addr: &str, key_args: &[serde_json::Value]) -> Option<Retained> {
        let key_part: Vec<String> = key_args.iter().map(|a| a.to_string()).collect();
        let key = format!("{}|{}", addr, key_part.join(","));
        let delta = self.retained.get(&key)?;
        Some(Retained {
            args: delta.args.clone(),
            observed_at: *self.retained_at.get(&key)?,
        })
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

    fn delta(addr: &str, index: u32, value: serde_json::Value) -> Delta {
        Delta { addr: addr.to_string(), args: vec![serde_json::json!(index), value] }
    }

    #[test]
    fn observe_delta_coalesces_and_retains_the_same_way_observe_does() {
        // A bulk-decoded delta (no OscMessage backing it) must behave
        // identically to one observed off the wire: last value wins within
        // a window, different track indices never collapse, and the value
        // survives drain() via retained.
        let mut c = Coalescer::new();
        c.observe_delta(delta("/live/track/get/name", 0, serde_json::json!("Kick")));
        c.observe_delta(delta("/live/track/get/name", 0, serde_json::json!("Snare")));
        c.observe_delta(delta("/live/track/get/name", 1, serde_json::json!("Bass")));

        let out = c.drain();
        assert_eq!(out.len(), 2, "two distinct track indices, last value wins per index");
        assert!(c.drain().is_empty());

        let snap = c.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().any(|d| d.args == vec![serde_json::json!(0), serde_json::json!("Snare")]));
        assert!(snap.iter().any(|d| d.args == vec![serde_json::json!(1), serde_json::json!("Bass")]));
    }

    #[test]
    fn shrinking_num_tracks_evicts_stale_track_entries_from_the_snapshot() {
        // Regression for the reviewer-caught bug: retained never evicted on
        // its own, so once bulk decoding started landing per-track values
        // there, a track deleted in Live would keep resurrecting as a
        // phantom row in a webview reload's snapshot(). A shrink must
        // actually remove those stale entries, not just stop refreshing
        // them.
        let mut c = Coalescer::new();
        for i in 0..3u32 {
            c.observe_delta(delta("/live/track/get/name", i, serde_json::json!(format!("Track {i}"))));
            c.observe_delta(delta("/live/track/get/volume", i, serde_json::json!(0.8)));
        }
        c.drain();
        assert_eq!(c.snapshot().len(), 6, "3 tracks * 2 addresses");

        // Track 2 is deleted; num_tracks shrinks from 3 to 2.
        c.evict_tracks_at_or_beyond(
            &["/live/track/get/name", "/live/track/get/volume"],
            2,
        );

        let snap = c.snapshot();
        assert_eq!(snap.len(), 4, "only tracks 0 and 1 survive the shrink");
        for d in &snap {
            let index = &d.args[0];
            assert!(
                *index == serde_json::json!(0) || *index == serde_json::json!(1),
                "expected only surviving indices 0 or 1, got {index:?}"
            );
        }
    }

    #[test]
    fn both_observation_paths_build_the_same_key_for_the_same_object() {
        // observe() used to key on format!("{OscType:?}") ("Int(3)") while
        // observe_delta() keyed on the JSON value ("3"). Nothing collided,
        // because every track address arrives by exactly one path -- but
        // evict_tracks_at_or_beyond's parse::<u32>() only ever worked on the
        // second form, and lookup() cannot be written against two conventions.
        let mut a = Coalescer::new();
        a.observe(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(3), OscType::Float(0.8)],
        ));

        let mut b = Coalescer::new();
        b.observe_delta(Delta {
            addr: "/live/track/get/volume".to_string(),
            args: vec![serde_json::json!(3), serde_json::json!(0.8)],
        });

        // Same object, so a second observation by either path must overwrite,
        // not accumulate.
        a.observe_delta(Delta {
            addr: "/live/track/get/volume".to_string(),
            args: vec![serde_json::json!(3), serde_json::json!(0.4)],
        });
        assert_eq!(a.snapshot().len(), 1);
        assert_eq!(a.snapshot()[0].args[1], serde_json::json!(0.4));
        assert_eq!(b.snapshot().len(), 1);
    }

    #[test]
    fn eviction_reaches_rows_that_arrived_through_observe() {
        let mut c = Coalescer::new();
        c.observe(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(5), OscType::Float(0.8)],
        ));
        c.evict_tracks_at_or_beyond(&["/live/track/get/volume"], 3);
        assert!(c.snapshot().is_empty());
    }

    #[test]
    fn lookup_returns_a_retained_value_with_the_time_it_was_observed() {
        let mut c = Coalescer::new();
        let before = Instant::now();
        c.observe_delta(Delta {
            addr: "/live/track/get/name".to_string(),
            args: vec![serde_json::json!(1), serde_json::json!("Bass")],
        });

        let found = c.lookup("/live/track/get/name", &[serde_json::json!(1)]).unwrap();
        assert_eq!(found.args[1], serde_json::json!("Bass"));
        assert!(found.observed_at >= before);
        assert!(c.lookup("/live/track/get/name", &[serde_json::json!(2)]).is_none());
    }

    #[test]
    fn lookup_survives_a_drain_because_a_mirror_read_is_not_a_delta() {
        let mut c = Coalescer::new();
        c.observe_delta(Delta {
            addr: "/live/track/get/name".to_string(),
            args: vec![serde_json::json!(1), serde_json::json!("Bass")],
        });
        c.drain();
        assert!(c.lookup("/live/track/get/name", &[serde_json::json!(1)]).is_some());
    }

    #[test]
    fn eviction_does_not_touch_other_addresses_or_smaller_indices() {
        let mut c = Coalescer::new();
        c.observe_delta(delta("/live/track/get/name", 0, serde_json::json!("Kick")));
        c.observe_delta(delta("/live/track/get/name", 5, serde_json::json!("Ghost")));
        // A non-track address sharing no prefix must be untouched.
        c.observe(&msg("/live/song/get/tempo", vec![OscType::Float(128.0)]));
        c.drain();

        c.evict_tracks_at_or_beyond(&["/live/track/get/name"], 5);

        let snap = c.snapshot();
        assert_eq!(snap.len(), 2, "track 0 and tempo survive; track 5 is evicted");
        assert!(snap.iter().any(|d| d.addr == "/live/track/get/name" && d.args[0] == serde_json::json!(0)));
        assert!(snap.iter().any(|d| d.addr == "/live/song/get/tempo"));
        assert!(!snap.iter().any(|d| d.args.first() == Some(&serde_json::json!(5))));
    }
}
