use super::arity::{key_arity, KeyArity};
use rosc::{OscMessage, OscType};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

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
    /// Addresses with an `Unkeyed` request currently in flight. Keyed per
    /// address, not a single global flag: `track_data`, `track_names`, and
    /// `mixer_data` reply at different addresses and so are trivially
    /// distinguishable from one another, even though each individually must
    /// be serialized against itself.
    unkeyed_outstanding: HashSet<String>,
    /// Callers awaiting a specific request's reply arguments.
    ///
    /// A `Vec` because `Registration::Joined` hands two callers the same
    /// `RequestId` and only one datagram will ever come back for them.
    /// Empty for every request the poll loop issues -- polling is
    /// fire-and-forget and reads its values out of the mirror, not out of
    /// a reply.
    waiters: HashMap<RequestId, Vec<oneshot::Sender<Vec<OscType>>>>,
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
            unkeyed_outstanding: HashSet::new(),
            waiters: HashMap::new(),
        }
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

    /// Returns a receiver that fires with the reply arguments when `id`
    /// resolves, or closes if `expire` reclaims the request first.
    ///
    /// MUST be called under the same lock guard as the `register` that
    /// produced `id`. Releasing the lock in between opens a window in which
    /// the reply arrives, `resolve` finds no waiter to hand it to, and the
    /// caller then waits out its whole timeout for a packet already
    /// consumed. `LiveQuery::query` is the only production caller and does
    /// both under one guard for exactly this reason.
    pub fn watch(&mut self, id: RequestId) -> oneshot::Receiver<Vec<OscType>> {
        let (tx, rx) = oneshot::channel();
        self.waiters.entry(id).or_default().push(tx);
        rx
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
        // Hand the reply to anyone awaiting this request. Observation and
        // resolution are unchanged: this only collects an answer that was
        // previously dropped on the floor.
        if let Some(id) = completed {
            for tx in self.waiters.remove(&id).unwrap_or_default() {
                // A receiver dropped before its reply arrived (the caller
                // timed out first) is normal, not an error.
                let _ = tx.send(msg.args.clone());
            }
        }
        Resolution { observation: true, completed }
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
        // Dropping the senders closes each receiver, so a caller blocked on
        // a request this table has given up on fails fast rather than
        // waiting out its own timeout as well.
        for id in &ids {
            self.waiters.remove(id);
        }
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
        // Timeline: request track 3's volume, the request times out and its
        // slot is freed by `expire`, a new request for track 3 goes out. The
        // late reply from the dead (expired) request then arrives.
        //
        // This layer CANNOT reject it: UDP carries no request ID, and the
        // zombie packet is byte-identical in every field the table keys on
        // to a legitimate reply for the current request. `expire` cancels
        // the table ENTRY, not the packet already in flight -- it has no way
        // to recall what Live already sent. So the zombie resolves the
        // CURRENT request. This is an inherent protocol limit, not a bug
        // here.
        //
        // Containment lives elsewhere, not in this table: no caller reads
        // `completed` as if it were a value; the genuine reply that follows
        // is still an observation and overwrites whatever stale value the
        // zombie wrote into the mirror; and polling re-corrects within one
        // cycle regardless.
        let mut t = RequestTable::new();
        let start = Instant::now();
        let old = match t.register(start, "/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        let later = start + Duration::from_secs(3);
        let cancelled = t.expire(later, Duration::from_secs(2));
        assert_eq!(cancelled, vec![old]);

        let new = match t.register(later, "/live/track/get/volume", &[OscType::Int(3)]) {
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
    fn an_unmatched_unkeyed_reply_does_not_clear_the_flag() {
        // mixer_data is outstanding. A resolve for track_data -- a different
        // Unkeyed address with nothing pending for it -- is unmatched
        // (completed: None) and must not clear mixer_data's flag.
        //
        // Under the current per-address keying this doesn't actually
        // exercise `resolve`'s `completed.is_some()` guard: an Unkeyed
        // address always has an empty key (`key_of` returns `vec![]` for
        // arity `Unkeyed`), so `PendingKey`s never collide across different
        // Unkeyed addresses in the first place -- the `addr` field alone
        // already keeps `mixer_data` and `track_data` apart. What this test
        // actually proves is that `resolve`'s address-scoped lookup does not
        // cross-clear another Unkeyed address's outstanding flag. The guard
        // would only be load-bearing if some future change made two
        // different addresses share a `PendingKey`, which nothing here does.
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

    #[test]
    fn a_watched_request_receives_the_replys_arguments() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(now, "/live/clip/get/length", &[OscType::Int(1), OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx = t.watch(id);

        t.resolve(&msg(
            "/live/clip/get/length",
            vec![OscType::Int(1), OscType::Int(0), OscType::Float(8.0)],
        ));

        assert_eq!(
            rx.try_recv().unwrap(),
            vec![OscType::Int(1), OscType::Int(0), OscType::Float(8.0)]
        );
    }

    #[test]
    fn joined_callers_each_receive_the_same_reply() {
        // Single-flight means the second caller never sends a datagram. It must
        // still get an answer, or a duplicate tool call would hang forever.
        let mut t = RequestTable::new();
        let now = Instant::now();
        let first = match t.register(now, "/live/clip/get/length", &[OscType::Int(1), OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx_a = t.watch(first);
        let second = match t.register(now, "/live/clip/get/length", &[OscType::Int(1), OscType::Int(0)]) {
            Registration::Joined(id) => id,
            other => panic!("expected Joined, got {other:?}"),
        };
        let mut rx_b = t.watch(second);

        t.resolve(&msg(
            "/live/clip/get/length",
            vec![OscType::Int(1), OscType::Int(0), OscType::Float(8.0)],
        ));

        assert!(rx_a.try_recv().is_ok());
        assert!(rx_b.try_recv().is_ok());
    }

    #[test]
    fn an_expired_request_drops_its_waiter_so_the_caller_sees_a_closed_channel() {
        // expire() is what frees the single-flight slot. Leaving a waiter behind
        // would strand the caller on a request the table no longer believes in.
        let mut t = RequestTable::new();
        let start = Instant::now();
        let id = match t.register(start, "/live/clip/get/notes", &[OscType::Int(1), OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx = t.watch(id);

        let later = start + Duration::from_secs(3);
        assert_eq!(t.expire(later, Duration::from_secs(2)), vec![id]);

        assert_eq!(rx.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Closed));
    }

    #[test]
    fn a_watcher_is_not_woken_by_a_different_keys_reply() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(now, "/live/clip/get/notes", &[OscType::Int(1), OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx = t.watch(id);

        // Same address, different clip.
        t.resolve(&msg(
            "/live/clip/get/notes",
            vec![OscType::Int(1), OscType::Int(1), OscType::Int(60)],
        ));

        assert_eq!(rx.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty));
    }
}
