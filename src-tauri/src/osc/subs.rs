#[cfg(test)]
use super::arity::{key_arity, KeyArity};

/// Only song and view are index-free, so only they are safe to subscribe.
/// Everything else is polled. See the spec: targeted stop_listen removes the
/// callback from whichever object currently holds the index, which after any
/// reorder is the wrong object — the real listener then leaks for the rest of
/// the session and keeps emitting at the old index.
pub const SINGLETON_SUBSCRIPTIONS: &[&str] = &[
    "/live/song/start_listen/tempo",
    "/live/song/start_listen/is_playing",
    "/live/song/start_listen/root_note",
    "/live/song/start_listen/scale_name",
    "/live/song/start_listen/loop",
    "/live/song/start_listen/loop_start",
    "/live/song/start_listen/loop_length",
    "/live/song/start_listen/signature_numerator",
    "/live/song/start_listen/signature_denominator",
    "/live/song/start_listen/beat",
    "/live/view/start_listen/selected_track",
    "/live/view/start_listen/selected_scene",
];

/// Answers "is this on the vetted subscribe list" — not "is this
/// structurally index-free". A prefix check on `/live/song/` or
/// `/live/view/` would also admit `/live/song/start_listen/current_song_time`,
/// which is index-free but explicitly excluded because its LOM listener
/// floods (see `never_subscribes_to_current_song_time`). Membership in
/// `SINGLETON_SUBSCRIPTIONS` is the actual guarantee this function's name
/// promises.
pub fn is_subscribable(addr: &str) -> bool {
    SINGLETON_SUBSCRIPTIONS.contains(&addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribes_only_to_index_free_objects() {
        // Subscribing to anything indexed leaks the LOM listener permanently
        // when the index later churns. This is the constraint the whole
        // poll-based design exists to enforce.
        for addr in SINGLETON_SUBSCRIPTIONS {
            assert!(
                addr.starts_with("/live/song/") || addr.starts_with("/live/view/"),
                "{addr} is indexed and must never be subscribed"
            );
        }
    }

    #[test]
    fn rejects_indexed_subscriptions() {
        assert!(!is_subscribable("/live/track/start_listen/volume"));
        assert!(!is_subscribable("/live/clip/start_listen/playing_position"));
        assert!(!is_subscribable("/live/device/start_listen/parameter/value"));
        assert!(is_subscribable("/live/song/start_listen/tempo"));
        assert!(is_subscribable("/live/view/start_listen/selected_track"));
        // The whole point: index-free but explicitly excluded because its
        // LOM listener floods. A prefix check would wrongly admit this.
        assert!(!is_subscribable("/live/song/start_listen/current_song_time"));
    }

    #[test]
    fn never_subscribes_to_current_song_time() {
        // Its LOM listener fires many times per second. The beat event exists
        // precisely to avoid it.
        assert!(!SINGLETON_SUBSCRIPTIONS
            .iter()
            .any(|a| a.contains("current_song_time")));
        assert!(SINGLETON_SUBSCRIPTIONS
            .iter()
            .any(|a| a.ends_with("/beat")));
    }

    #[test]
    fn every_subscription_has_an_arity_entry_at_its_reply_address() {
        // A subscription's replies arrive at the `get` address, not the
        // `start_listen` address. key_arity's match is a literal exhaustive
        // list, so any address missing from it silently resolves to Unknown
        // and RequestTable::register's panic can never catch it — that path
        // only fires for addresses that get registered as outgoing requests,
        // and a pushed subscription reply is never registered. This test
        // shipped after the arity map was found missing 7 of these addresses,
        // caught only by manual cross-referencing. If this fails, fix
        // arity.rs — do not weaken this test.
        for addr in SINGLETON_SUBSCRIPTIONS {
            let get_addr = addr.replacen("start_listen", "get", 1);
            assert_ne!(
                key_arity(&get_addr),
                KeyArity::Unknown,
                "{get_addr} (reply address for subscription {addr}) has no arity entry"
            );
        }
    }
}
