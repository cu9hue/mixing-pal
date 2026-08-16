use super::arity::{key_arity, KeyArity};
use rosc::{OscMessage, OscType};
use std::collections::HashMap;
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
    unkeyed_outstanding: bool,
}

/// OSC ints and floats both appear as keys; render them stably so an Int(3)
/// key from a request matches the Int(3) that comes back in the reply.
fn key_of(args: &[OscType], n: usize) -> Vec<String> {
    args.iter()
        .take(n)
        .map(|a| match a {
            OscType::Int(i) => format!("i{i}"),
            OscType::Float(f) => format!("f{f}"),
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
            unkeyed_outstanding: false,
        }
    }

    /// The current generation counter. Bumped by `bump_generation`; exposed so
    /// the concept is inspectable from outside the table, not just internally
    /// mutated.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn register(&mut self, addr: &str, args: &[OscType]) -> Registration {
        let arity = key_arity(addr);
        if arity == KeyArity::Unknown {
            panic!("no arity entry for {addr}; add it to arity.rs");
        }
        if arity == KeyArity::Unkeyed {
            if self.unkeyed_outstanding {
                return Registration::Deferred;
            }
            self.unkeyed_outstanding = true;
        }

        let n = match arity {
            KeyArity::Args(n) => n,
            _ => 0,
        };
        let key = PendingKey {
            addr: addr.to_string(),
            key: key_of(args, n),
        };

        if let Some(existing) = self.pending.get(&key) {
            return Registration::Joined(existing.id);
        }

        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(
            key,
            Pending { id, issued: Instant::now() },
        );
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
        if completed.is_some() && arity == KeyArity::Unkeyed {
            self.unkeyed_outstanding = false;
        }
        Resolution { observation: true, completed }
    }

    /// Any topology change invalidates in-flight work keyed by index.
    pub fn bump_generation(&mut self) -> Vec<RequestId> {
        self.generation += 1;
        self.unkeyed_outstanding = false;
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
                self.unkeyed_outstanding = false;
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
        let id = match t.register("/live/track/get/volume", &[OscType::Int(3)]) {
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
        let id = match t.register(
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
        let first = t.register("/live/track/get/name", &[OscType::Int(1)]);
        let second = t.register("/live/track/get/name", &[OscType::Int(1)]);
        assert!(matches!(first, Registration::New(_)));
        assert!(matches!(second, Registration::Joined(_)));
    }

    #[test]
    fn unkeyed_requests_are_serialized() {
        // track_data replies echo no range, so two in flight cannot be told
        // apart. The second must wait rather than race.
        let mut t = RequestTable::new();
        let first = t.register(
            "/live/song/get/track_data",
            &[OscType::Int(0), OscType::Int(8)],
        );
        assert!(matches!(first, Registration::New(_)));
        let second = t.register(
            "/live/song/get/track_data",
            &[OscType::Int(8), OscType::Int(16)],
        );
        assert!(matches!(second, Registration::Deferred));
    }

    #[test]
    fn a_zombie_reply_cannot_resolve_a_request_from_a_later_generation() {
        // Timeline: request track 3's volume, a track is deleted, the world is
        // regenerated, a new request for track 3 goes out. The late reply from
        // the dead request carries the OLD track's value and must be discarded
        // as a resolution, though it still counts as an observation.
        let mut t = RequestTable::new();
        let old = match t.register("/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };

        let cancelled = t.bump_generation();
        assert_eq!(cancelled, vec![old]);

        let new = match t.register("/live/track/get/volume", &[OscType::Int(3)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        assert_ne!(old, new);

        let r = t.resolve(&msg(
            "/live/track/get/volume",
            vec![OscType::Int(3), OscType::Float(0.5)],
        ));
        // It resolves the CURRENT request, not the cancelled one.
        assert_eq!(r.completed, Some(new));
        assert!(r.observation);
    }

    #[test]
    fn expired_requests_are_reported_once() {
        let mut t = RequestTable::new();
        let id = match t.register("/live/track/get/name", &[OscType::Int(0)]) {
            Registration::New(id) => id,
            other => panic!("expected New, got {other:?}"),
        };
        let start = Instant::now();
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
}
