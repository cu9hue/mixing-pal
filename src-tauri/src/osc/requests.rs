use super::arity::{key_arity, KeyArity};
use rosc::{OscMessage, OscType};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub type RequestId = u64;

#[derive(Debug, PartialEq, Eq)]
pub enum Registration {
    New(RequestId),
    Joined(RequestId),
    /// An unkeyed request is already outstanding; retry when it clears.
    Deferred,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Resolution {
    /// Always true. Every packet updates the mirror, resolution or not.
    pub observation: bool,
    pub completed: Option<RequestId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PendingKey {
    addr: String,
    key: Vec<String>,
}

struct Pending {
    id: RequestId,
    issued: Instant,
}

pub struct RequestTable {
    pending: HashMap<PendingKey, Pending>,
    next_id: RequestId,
    generation: u64,
    /// Addresses with an `Unkeyed` request currently in flight. Keyed per
    /// address, not a single global flag: `track_data`, `track_names`, and
    /// `mixer_data` reply at different addresses and so are trivially
    /// distinguishable from one another, even though each individually must
    /// be serialized against itself.
    unkeyed_outstanding: HashSet<String>,
}

/// Only integer and string keys are supported: render them stably so an
/// Int(3) key from a request matches the Int(3) that comes back in the
/// reply. No endpoint in the current arity map keys on a float, and floats
/// are deliberately left in the catch-all arm rather than given real
/// handling — `NaN` and `-NaN` both render as `"fNaN"` and would collide, so
/// a float key would be unsound to trust.
fn key_of(args: &[OscType], n: usize) -> Vec<String> {
    args.iter()
        .take(n)
        .map(|a| match a {
            OscType::Int(i) => format!("i{i}"),
            OscType::String(s) => format!("s{s}"),
            other => format!("?{other:?}"),
        })
        .collect()
}

impl RequestTable {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 1,
            generation: 0,
            unkeyed_outstanding: HashSet::new(),
        }
    }

    /// A monotonic marker for the current topology epoch, bumped by
    /// `bump_generation`. It does NOT and cannot filter inbound packets:
    /// nothing stamps the generation onto the wire, so a reply already in
    /// flight when the epoch turns arrives byte-identical to a legitimate
    /// one and this table cannot reject it. See
    /// `a_zombie_reply_is_indistinguishable_and_resolves_the_current_request`
    /// for what that means for a caller. This accessor exists only so the
    /// counter is inspectable from outside the table, not internally mutated
    /// and never read.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn register(&mut self, now: Instant, addr: &str, args: &[OscType]) -> Registration {
        let arity = key_arity(addr);
        if arity == KeyArity::Unknown {
            panic!("no arity entry for {addr}; add it to arity.rs");
        }

        let n = match arity {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        assert!(
            args.len() >= n,
            "{addr} keys on {n} args but only {} were given; a short reply \
             could match a truncated key",
            args.len()
        );

        if arity == KeyArity::Unkeyed {
            if self.unkeyed_outstanding.contains(addr) {
                return Registration::Deferred;
            }
            self.unkeyed_outstanding.insert(addr.to_string());
        }

        let key = PendingKey {
            addr: addr.to_string(),
            key: key_of(args, n),
        };

        if let Some(existing) = self.pending.get(&key) {
            return Registration::Joined(existing.id);
        }

        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(key, Pending { id, issued: now });
        Registration::New(id)
    }

    pub fn resolve(&mut self, msg: &OscMessage) -> Resolution {
        let arity = key_arity(&msg.addr);
        let n = match arity {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        let key = PendingKey {
            addr: msg.addr.clone(),
            key: key_of(&msg.args, n),
        };
        let completed = self.pending.remove(&key).map(|p| p.id);
        // Only a matched completion clears the gate. An unmatched, stray
        // packet at an Unkeyed address must not unlock a slot nothing
        // actually freed.
        if completed.is_some() && arity == KeyArity::Unkeyed {
            self.unkeyed_outstanding.remove(&msg.addr);
        }
        Resolution { observation: true, completed }
    }

    /// Any topology change invalidates in-flight work keyed by index.
    pub fn bump_generation(&mut self) -> Vec<RequestId> {
        self.generation += 1;
        self.unkeyed_outstanding.clear();
        let mut cancelled: Vec<RequestId> =
            self.pending.drain().map(|(_, p)| p.id).collect();
        cancelled.sort_unstable();
        cancelled
    }

    pub fn expire(&mut self, now: Instant, timeout: Duration) -> Vec<RequestId> {
        let stale: Vec<PendingKey> = self
            .pending
            .iter()
            .filter(|(_, p)| now.duration_since(p.issued) > timeout)
            .map(|(k, _)| k.clone())
            .collect();
        let mut ids = Vec::new();
        for key in stale {
            if key_arity(&key.addr) == KeyArity::Unkeyed {
                self.unkeyed_outstanding.remove(&key.addr);
            }
            if let Some(p) = self.pending.remove(&key) {
                ids.push(p.id);
            }
        }
        ids.sort_unstable();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::{OscMessage, OscType};
    use std::time::{Duration, Instant};

    fn msg(addr: &str, args: Vec<OscType>) -> OscMessage {
        OscMessage { addr: addr.to_string(), args }
    }

    #[test]
    fn every_inbound_packet_is_an_observation_even_with_no_pending_request() {
        // A subscription update arrives with nothing outstanding. It must still
        // reach the mirror; only the promise resolution is absent.
        let mut t = RequestTable::new();
        let r = t.resolve(&msg("/live/song/get/tempo", vec![OscType::Float(128.0)]));
        assert!(r.observation);
        assert_eq!(r.completed, None);
    }

    #[test]
    fn resolves_a_keyed_reply_to_the_matching_track_only() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(now, "/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        // Track 5's reply must not resolve track 3's request.
        let other = t.resolve(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(5), OscType::Float(0.7)],
        ));
        assert_eq!(other.completed, None);

        let mine = t.resolve(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(3), OscType::Float(0.9)],
        ));
        assert_eq!(mine.completed, Some(id));
    }

    #[test]
    fn distinguishes_clips_by_both_key_args() {
        // /live/clip/get/notes keys on (track, clip). Keying on track alone
        // would resolve clip (2,0) with clip (2,1)'s notes.
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(
            now,
            "/live/clip/get/notes",
            &[OscType::Int(2), OscType::Int(0)],
        ) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let wrong = t.resolve(&msg(
            "/live/clip/get/notes",
            vec![OscType::Int(2), OscType::Int(1), OscType::Int(60)],
        ));
        assert_eq!(wrong.completed, None);

        let right = t.resolve(&msg(
            "/live/clip/get/notes",
            vec![OscType::Int(2), OscType::Int(0), OscType::Int(60)],
        ));
        assert_eq!(right.completed, Some(id));
    }

    #[test]
    fn duplicate_requests_join_instead_of_sending_twice() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let first = t.register(now, "/live/track/get/name", &[OscType::Int(1)]);
        let second = t.register(now, "/live/track/get/name", &[OscType::Int(1)]);
        assert!(matches!(first, Registration::New(_)));
        assert!(matches!(second, Registration::Joined(_)));
    }

    #[test]
    fn unkeyed_requests_are_serialized() {
        // track_data replies echo no range, so two in flight cannot be told
        // apart. The second must wait rather than race.
        let mut t = RequestTable::new();
        let now = Instant::now();
        let first = t.register(
            now,
            "/live/song/get/track_data",
            &[OscType::Int(0), OscType::Int(8)],
        );
        assert!(matches!(first, Registration::New(_)));
        let second = t.register(
            now,
            "/live/song/get/track_data",
            &[OscType::Int(8), OscType::Int(16)],
        );
        assert!(matches!(second, Registration::Deferred));
    }

    #[test]
    fn unkeyed_serialization_is_per_address_not_global() {
        // track_data and mixer_data reply at different addresses and are
        // trivially distinguishable from one another. Serializing across
        // them buys nothing and starves Task 12's poll of both on the same
        // tick, so one Unkeyed address outstanding must not defer another.
        let mut t = RequestTable::new();
        let now = Instant::now();
        let track_data = t.register(
            now,
            "/live/song/get/track_data",
            &[OscType::Int(0), OscType::Int(8)],
        );
        assert!(matches!(track_data, Registration::New(_)));
        let mixer_data = t.register(now, "/live/track/get/mixer_data", &[]);
        assert!(matches!(mixer_data, Registration::New(_)));
    }

    #[test]
    fn a_zombie_reply_is_indistinguishable_and_resolves_the_current_request() {
        // Timeline: request track 3's volume, a track is deleted, the world is
        // regenerated, a new request for track 3 goes out. The late reply from
        // the dead (cancelled) request then arrives.
        //
        // This layer CANNOT reject it: UDP carries no request ID, nothing
        // stamps the generation onto the wire, and the zombie packet is
        // byte-identical in every field the table keys on to a legitimate
        // reply for the current request. `bump_generation` cancels the table
        // ENTRY, not the packet already in flight -- it has no way to recall
        // what Live already sent. So the zombie resolves the CURRENT
        // request. This is an inherent protocol limit, not a bug here.
        //
        // Containment lives elsewhere, not in this table: no caller reads
        // `completed` as if it were a value; the genuine reply that follows
        // is still an observation and overwrites whatever stale value the
        // zombie wrote into the mirror; and polling re-corrects within one
        // cycle regardless. See `RequestTable::generation` for how the
        // generation counter relates to this (it does not filter packets).
        let mut t = RequestTable::new();
        let now = Instant::now();
        let old = match t.register(now, "/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        let cancelled = t.bump_generation();
        assert_eq!(cancelled, vec![old]);

        let new = match t.register(now, "/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        assert_ne!(old, new);

        let r = t.resolve(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(3), OscType::Float(0.5)],
        ));
        // The zombie (old's reply) resolves `new` -- indistinguishable, not
        // rejected.
        assert_eq!(r.completed, Some(new));
        assert!(r.observation);
    }

    #[test]
    fn expired_requests_are_reported_once() {
        let mut t = RequestTable::new();
        let start = Instant::now();
        let id = match t.register(start, "/live/track/get/name", &[OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        assert!(t.expire(start, Duration::from_secs(2)).is_empty());
        let later = start + Duration::from_secs(3);
        assert_eq!(t.expire(later, Duration::from_secs(2)), vec![id]);
        assert!(t.expire(later, Duration::from_secs(2)).is_empty());
    }

    #[test]
    fn generation_increases_after_bump_generation() {
        let mut t = RequestTable::new();
        let before = t.generation();
        t.bump_generation();
        assert!(t.generation() > before);
    }

    #[test]
    fn unkeyed_flag_clears_on_resolve() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        t.register(now, "/live/track/get/mixer_data", &[]);
        t.resolve(&msg("/live/track/get/mixer_data", vec![OscType::Int(1)]));
        let again = t.register(now, "/live/track/get/mixer_data", &[]);
        assert!(matches!(again, Registration::New(_)));
    }

    #[test]
    fn unkeyed_flag_clears_on_expire() {
        let mut t = RequestTable::new();
        let start = Instant::now();
        t.register(start, "/live/track/get/mixer_data", &[]);
        let later = start + Duration::from_secs(10);
        assert_eq!(t.expire(later, Duration::from_secs(2)).len(), 1);
        let again = t.register(later, "/live/track/get/mixer_data", &[]);
        assert!(matches!(again, Registration::New(_)));
    }

    #[test]
    fn unkeyed_flag_clears_on_bump_generation() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        t.register(now, "/live/track/get/mixer_data", &[]);
        t.bump_generation();
        let again = t.register(now, "/live/track/get/mixer_data", &[]);
        assert!(matches!(again, Registration::New(_)));
    }

    #[test]
    fn an_unmatched_unkeyed_reply_does_not_clear_the_flag() {
        // mixer_data is outstanding. A resolve for track_data -- a different
        // Unkeyed address with nothing pending for it -- is unmatched
        // (completed: None) and must not clear mixer_data's flag. Without
        // the `completed.is_some()` guard on the resolve path, an unmatched
        // reply could unlock a slot nothing actually freed.
        let mut t = RequestTable::new();
        let now = Instant::now();
        t.register(now, "/live/track/get/mixer_data", &[]);
        let stray = t.resolve(&msg("/live/song/get/track_data", vec![OscType::Int(1)]));
        assert_eq!(stray.completed, None);
        let still_outstanding = t.register(now, "/live/track/get/mixer_data", &[]);
        assert!(matches!(still_outstanding, Registration::Deferred));
    }

    #[test]
    #[should_panic(expected = "no arity entry")]
    fn register_panics_on_an_unknown_address_rather_than_guess() {
        let mut t = RequestTable::new();
        t.register(Instant::now(), "/live/track/get/invented", &[OscType::Int(0)]);
    }

    #[test]
    fn resolve_on_an_unknown_address_does_not_panic_and_is_a_bare_observation() {
        // Live does emit addresses outside the arity map (e.g. informational
        // pushes this design doesn't query). resolve must not panic on them;
        // it only ever completes a request, never rejects a packet.
        let mut t = RequestTable::new();
        let r = t.resolve(&msg("/live/track/get/invented", vec![OscType::Int(0)]));
        assert!(r.observation);
        assert_eq!(r.completed, None);
    }

    #[test]
    #[should_panic]
    fn register_panics_on_an_under_keyed_request() {
        // /live/clip/get/notes keys on 2 args (track, clip). Registering it
        // with only 1 would build a short key that a 1-arg reply could match,
        // silently under-specifying which clip the caller meant.
        let mut t = RequestTable::new();
        t.register(Instant::now(), "/live/clip/get/notes", &[OscType::Int(2)]);
    }
}
