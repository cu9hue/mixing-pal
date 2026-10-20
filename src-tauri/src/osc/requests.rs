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

    /// Frees a request's single-flight slot immediately, instead of leaving
    /// it for `expire`'s window to elapse.
    ///
    /// A caller that gave up on its own request must release the slot, or the
    /// next request for the SAME key -- which for an `Args(n)` address means
    /// the same first n arguments, even with different trailing arguments --
    /// would `Joined` a dead entry and never be sent at all.
    ///
    /// Only the caller that received `Registration::New` may cancel, and it
    /// must pass the `RequestId` that came back with it. The id, not just
    /// the caller's identity, is what `cancel` checks: `expire` can reclaim
    /// this same key out from under a stalled caller and hand it to a fresh
    /// registrant before the stalled caller gets here (A registers id=1,
    /// `expire` reclaims it, B registers id=2 for the same key, A finally
    /// calls cancel). Without the id, cancel would delete whatever entry
    /// currently sits under the key -- B's live request -- which is the same
    /// cross-caller cancellation the `New`-only rule exists to prevent,
    /// reached by a different route. Matching on id makes a stale cancel a
    /// no-op instead.
    pub fn cancel(&mut self, addr: &str, args: &[OscType], id: RequestId) {
        let arity = key_arity(addr);
        let n = match arity {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        let key = PendingKey {
            addr: addr.to_string(),
            key: key_of(args, n),
        };
        if let std::collections::hash_map::Entry::Occupied(entry) = self.pending.entry(key) {
            if entry.get().id != id {
                // Someone else now owns this key; leave their request alone.
                return;
            }
            let pending = entry.remove();
            // Dropping the senders closes any receiver still waiting, which
            // is the same signal `expire` gives.
            self.waiters.remove(&pending.id);
            if arity == KeyArity::Unkeyed {
                self.unkeyed_outstanding.remove(addr);
            }
        }
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
    fn a_reply_for_one_note_window_cannot_resolve_another_windows_request() {
        // The whole reason `/live/clip/get/notes_window` exists. Upstream's
        // `/live/clip/get/notes` echoes only (track, clip), so every window
        // of one clip shares a key: a window the caller gave up on can come
        // back late and resolve whichever window is waiting now. The notes
        // then fail the consumer's range filter, the window is recorded as
        // answered-with-nothing, and its real notes are never fetched --
        // a partial read that reports itself complete.
        //
        // Echoing the window ordinal makes the two requests different keys,
        // so the stale reply matches nothing and dies here, which is where
        // `/live/device/get/parameters/*_range` has always killed it.
        let addr = "/live/clip/get/notes_window";
        let mut t = RequestTable::new();
        let now = Instant::now();

        // Window 0 goes out and the caller gives up on it.
        let first = vec![OscType::Int(2), OscType::Int(1), OscType::Int(0)];
        let id = match t.register(now, addr, &first) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        t.cancel(addr, &first, id);

        // Window 1 is the one in flight now.
        let second = vec![OscType::Int(2), OscType::Int(1), OscType::Int(1)];
        let waiting = match t.register(now, addr, &second) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx = t.watch(waiting);

        // Live finally answers window 0.
        let stale = t.resolve(&msg(
            addr,
            vec![
                OscType::Int(2),
                OscType::Int(1),
                OscType::Int(0),
                OscType::Int(60),
                OscType::Float(0.0),
                OscType::Float(0.5),
                OscType::Float(100.0),
                OscType::Bool(false),
            ],
        ));

        assert_eq!(stale.completed, None, "a given-up window's reply must match nothing");
        assert!(
            rx.try_recv().is_err(),
            "window 1 must still be waiting for its OWN reply"
        );

        // And window 1's own reply still resolves it.
        let own = t.resolve(&msg(
            addr,
            vec![OscType::Int(2), OscType::Int(1), OscType::Int(1)],
        ));
        assert_eq!(own.completed, Some(waiting));
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
    fn cancelling_a_keyed_request_frees_the_slot_for_a_fresh_registration() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let args = [OscType::Int(1), OscType::Int(0)];
        let id = match t.register(now, "/live/clip/get/notes", &args) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        t.cancel("/live/clip/get/notes", &args, id);

        let after = t.register(now, "/live/clip/get/notes", &args);
        assert!(
            matches!(after, Registration::New(_)),
            "expected New after cancel, got {after:?}"
        );
    }

    #[test]
    fn cancelling_drops_the_waiter_so_the_receiver_sees_a_closed_channel() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let args = [OscType::Int(1), OscType::Int(0)];
        let id = match t.register(now, "/live/clip/get/notes", &args) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let mut rx = t.watch(id);

        t.cancel("/live/clip/get/notes", &args, id);

        assert_eq!(rx.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Closed));
    }

    #[test]
    fn cancelling_an_unkeyed_request_clears_its_outstanding_flag() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(now, "/live/track/get/mixer_data", &[]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        t.cancel("/live/track/get/mixer_data", &[], id);

        let after = t.register(now, "/live/track/get/mixer_data", &[]);
        assert!(
            matches!(after, Registration::New(_)),
            "expected New after cancel, got {after:?}"
        );
    }

    #[test]
    fn cancelling_a_key_that_is_not_pending_is_a_harmless_no_op() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let id = match t.register(now, "/live/track/get/name", &[OscType::Int(1)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        // Nothing is pending for track 2; cancelling it must not touch
        // track 1's entry. Pass id + 1 as a stand-in id -- there is no real
        // registration for track 2's key at all, so any id is a non-match.
        t.cancel("/live/track/get/name", &[OscType::Int(2)], id + 1);

        let still_joined = t.register(now, "/live/track/get/name", &[OscType::Int(1)]);
        assert_eq!(still_joined, Registration::Joined(id));
    }

    #[test]
    fn cancelling_with_a_stale_id_does_not_delete_a_newer_owners_request() {
        // The ABA sequence cancel's id check exists to rule out: A registers
        // id1 for key K, expire() reclaims it (A stalls before reaching
        // cancel), B registers id2 for the SAME key, and only then does A's
        // stale cancel(id1) run. It must find id2 sitting under the key,
        // refuse to touch it, and leave B's request -- and its waiter --
        // fully intact.
        let mut t = RequestTable::new();
        let start = Instant::now();
        let addr = "/live/clip/get/notes";
        let args = [OscType::Int(1), OscType::Int(0)];

        let id1 = match t.register(start, addr, &args) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        let later = start + Duration::from_secs(3);
        assert_eq!(t.expire(later, Duration::from_secs(2)), vec![id1]);

        let id2 = match t.register(later, addr, &args) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        assert_ne!(id1, id2);
        let mut rx2 = t.watch(id2);

        // A's stale cancel, arriving after expire already moved this key
        // on to id2.
        t.cancel(addr, &args, id1);

        // The survivor: a fresh registration for K still Joins id2, and
        // id2's waiter is still alive (not closed by A's stale cancel).
        let still_joined = t.register(later, addr, &args);
        assert_eq!(still_joined, Registration::Joined(id2));
        assert_eq!(rx2.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty));
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

    // Two Drum Rack pads read at once: the dotted path is one key argument,
    // so "0.0.0" and "0.1.0" can never resolve each other.
    #[test]
    fn sibling_device_paths_resolve_their_own_replies() {
        let mut t = RequestTable::new();
        let now = Instant::now();
        let addr = "/live/mixingpal/get/sample";
        let key = |path: &str| vec![OscType::Int(0), OscType::Int(2), OscType::String(path.into())];
        let Registration::New(kick) = t.register(now, addr, &key("0.0.0")) else { panic!("kick") };
        let Registration::New(snare) = t.register(now, addr, &key("0.1.0")) else { panic!("snare") };
        let mut reply = key("0.1.0");
        reply.push(OscType::String("ok".into()));
        assert_eq!(t.resolve(&msg(addr, reply)).completed, Some(snare));
        let mut reply = key("0.0.0");
        reply.push(OscType::String("ok".into()));
        assert_eq!(t.resolve(&msg(addr, reply)).completed, Some(kick));
    }
}
