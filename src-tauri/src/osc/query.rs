use super::requests::{Registration, RequestTable};
use super::socket::OscSocket;
use rosc::OscType;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Why a live query produced no value. Serialised into a tool result's
/// `missing_reason`, so the model can tell "Live said zero" from "Live said
/// nothing".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryError {
    /// No reply inside the timeout. Also what an oversized reply looks like:
    /// Live's `sendto` raises past `MAX_DATAGRAM` and the client receives
    /// nothing at all, so the two are indistinguishable here by design.
    NoReply,
    /// A single-flight (`KeyArity::Unkeyed`) address stayed occupied for the
    /// whole timeout.
    Busy,
    /// The datagram could not be sent, or the table's lock was poisoned.
    Transport(String),
}

/// Sends a read-only request and awaits its own reply.
///
/// The poll loop is fire-and-forget: it sends, and the receive loop mirrors
/// whatever comes back. A tool call needs the opposite, and this is the only
/// thing in the codebase that consumes the `RequestId` the table has always
/// returned.
pub struct LiveQuery {
    socket: Arc<OscSocket>,
    table: Arc<Mutex<RequestTable>>,
}

/// How long to wait for a deferred single-flight slot before re-registering.
const BUSY_BACKOFF: Duration = Duration::from_millis(50);

impl LiveQuery {
    pub fn new(socket: Arc<OscSocket>, table: Arc<Mutex<RequestTable>>) -> Self {
        Self { socket, table }
    }

    pub async fn query(
        &self,
        addr: &str,
        args: Vec<OscType>,
        timeout: Duration,
    ) -> Result<Vec<OscType>, QueryError> {
        let deadline = Instant::now() + timeout;
        loop {
            // Register and watch under ONE guard -- see RequestTable::watch.
            // The guard is scoped to this block and dropped before any
            // .await below, which is also what keeps the std::sync::Mutex
            // legal here.
            let (registration, rx) = {
                let mut t = self
                    .table
                    .lock()
                    .map_err(|_| QueryError::Transport("request table lock poisoned".into()))?;
                let registration = t.register(Instant::now(), addr, &args);
                let rx = match registration {
                    Registration::New(id) | Registration::Joined(id) => Some(t.watch(id)),
                    Registration::Deferred => None,
                };
                (registration, rx)
            };

            match registration {
                Registration::New(id) => {
                    if let Err(error) = self.socket.send(addr, args.clone()).await {
                        if let Ok(mut table) = self.table.lock() {
                            table.cancel(addr, &args, id);
                        }
                        return Err(QueryError::Transport(error.to_string()));
                    }
                }
                // An equivalent request is already on the wire; its reply
                // will reach this watcher too.
                Registration::Joined(_) => {}
                Registration::Deferred => {
                    if Instant::now() >= deadline {
                        return Err(QueryError::Busy);
                    }
                    tokio::time::sleep(BUSY_BACKOFF).await;
                    continue;
                }
            }

            // Only the New registrant may free the slot on give-up -- and it
            // must cancel by this exact id, not just by key, or a cancel
            // that arrives after `expire` has already handed the key to a
            // fresh registrant would delete that registrant's live request
            // instead of the dead one this caller owned. See `cancel`'s doc
            // comment for the full sequence.
            let owned_id = match registration {
                Registration::New(id) => Some(id),
                _ => None,
            };
            let rx = rx.expect("New and Joined always produce a receiver");
            let remaining = deadline.saturating_duration_since(Instant::now());
            return match tokio::time::timeout(remaining, rx).await {
                Ok(Ok(reply)) => Ok(reply),
                // The channel closed: `expire` reclaimed the slot and
                // dropped the waiter. Same outcome as running out of time.
                Ok(Err(_)) | Err(_) => {
                    if let Some(id) = owned_id {
                        let mut t = self
                            .table
                            .lock()
                            .map_err(|_| QueryError::Transport("request table lock poisoned".into()))?;
                        t.cancel(addr, &args, id);
                    }
                    Err(QueryError::NoReply)
                }
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::{Registration, RequestTable};

    /// Stands in for `lib.rs`'s receive loop: the only part of it a query
    /// depends on is that every inbound datagram reaches
    /// `RequestTable::resolve`.
    fn spawn_receive_loop(socket: Arc<OscSocket>, table: Arc<Mutex<RequestTable>>) {
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = socket.recv().await {
                    if let Ok(mut t) = table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });
    }

    async fn fixture() -> (OscSocket, Arc<LiveQuery>, Arc<Mutex<RequestTable>>, u16) {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));
        spawn_receive_loop(app.clone(), table.clone());
        (live, Arc::new(LiveQuery::new(app, table.clone())), table, app_port)
    }

    #[tokio::test]
    async fn a_query_resolves_with_the_replys_arguments() {
        let (live, q, _table, app_port) = fixture().await;

        tokio::spawn(async move {
            let req = live.recv().await.unwrap();
            assert_eq!(req.addr, "/live/clip/get/length");
            live.send_to(
                app_port,
                "/live/clip/get/length",
                vec![OscType::Int(1), OscType::Int(0), OscType::Float(8.0)],
            )
            .await
            .unwrap();
        });

        let reply = q
            .query(
                "/live/clip/get/length",
                vec![OscType::Int(1), OscType::Int(0)],
                Duration::from_millis(500),
            )
            .await
            .unwrap();
        assert_eq!(reply[2], OscType::Float(8.0));
    }

    #[tokio::test]
    async fn a_query_nothing_answers_reports_no_reply() {
        // What an oversized reply also looks like on the wire: Live's sendto
        // raises and the client receives nothing at all. The caller, which
        // knows whether a smaller window is worth trying, is what turns this
        // into "too_large".
        //
        // The fake Live here does receive the request -- proving the New
        // path really sent a datagram -- and deliberately never answers it,
        // so this test fails both if the send is silently dropped and if
        // the timeout path breaks.
        let (live, q, _table, _port) = fixture().await;
        let received = tokio::spawn(async move { live.recv().await });

        let err = q
            .query(
                "/live/clip/get/length",
                vec![OscType::Int(1), OscType::Int(0)],
                Duration::from_millis(120),
            )
            .await
            .unwrap_err();
        assert_eq!(err, QueryError::NoReply);

        let req = received.await.unwrap().unwrap();
        assert_eq!(req.addr, "/live/clip/get/length");
        assert_eq!(req.args, vec![OscType::Int(1), OscType::Int(0)]);
    }

    #[tokio::test]
    async fn a_joined_query_sends_no_second_datagram_and_still_receives_the_reply() {
        // A request for this key is already in flight when the joined
        // caller's query() runs. It must ride the existing request rather
        // than send its own datagram, and it must still receive the answer
        // that resolves the shared request id.
        let (live, q, table, _port) = fixture().await;
        let addr = "/live/clip/get/length";
        let args = vec![OscType::Int(1), OscType::Int(0)];

        {
            let mut t = table.lock().unwrap();
            match t.register(Instant::now(), addr, &args) {
                Registration::New(_) => {}
                other => panic!("expected New, got {other:?}"),
            }
        }

        let q2 = q.clone();
        let joined = tokio::spawn(async move {
            q2.query(addr, args, Duration::from_millis(500)).await
        });

        // Give the spawned query a chance to run its register-and-watch
        // before any reply arrives, so the resolve below finds a waiter.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let nothing = tokio::time::timeout(Duration::from_millis(50), live.recv()).await;
        assert!(nothing.is_err(), "a joined query must not send its own datagram");

        // LiveQuery never learns request ids, so the only way to complete
        // the pre-registered request in this test is to resolve it
        // directly, exactly as the real receive loop would on an inbound
        // datagram.
        {
            let mut t = table.lock().unwrap();
            t.resolve(&rosc::OscMessage {
                addr: addr.to_string(),
                args: vec![OscType::Int(1), OscType::Int(0), OscType::Float(8.0)],
            });
        }

        let reply = joined.await.unwrap().unwrap();
        assert_eq!(reply[2], OscType::Float(8.0));
    }

    #[tokio::test]
    async fn a_second_query_for_the_same_key_after_the_first_times_out_still_sends_a_datagram() {
        // Regression test: before the fix, a timed-out New registrant left
        // its entry in the table. A retry for the same (track, clip) key
        // then `Joined` the dead entry and its datagram was never sent. The
        // fake Live here never answers either query, so the second query's
        // datagram is the only proof the retry actually went out.
        let (live, q, _table, _port) = fixture().await;
        let addr = "/live/clip/get/notes";
        let args = vec![OscType::Int(1), OscType::Int(0)];

        let first = q
            .query(addr, args.clone(), Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(first, QueryError::NoReply);

        // Drain the first datagram off the wire.
        let first_on_wire = tokio::time::timeout(Duration::from_millis(200), live.recv())
            .await
            .expect("the first query must have sent a datagram")
            .unwrap();
        assert_eq!(first_on_wire.addr, addr);

        let second = q
            .query(addr, args.clone(), Duration::from_millis(100))
            .await
            .unwrap_err();
        assert_eq!(second, QueryError::NoReply);

        let second_on_wire = tokio::time::timeout(Duration::from_millis(200), live.recv()).await;
        let second_on_wire = second_on_wire
            .expect("the retry must also send its own datagram, not silently Join a dead entry")
            .unwrap();
        assert_eq!(second_on_wire.addr, addr);
        assert_eq!(second_on_wire.args, args);
    }

    #[tokio::test]
    async fn a_joined_callers_timeout_does_not_cancel_the_owners_request() {
        // The owner registered New and is still waiting. A second caller
        // Joins that request, then times out on its own shorter deadline.
        // The owner's entry must survive: a later registration for the same
        // key must still Join it, not New it.
        let (_live, q, table, _port) = fixture().await;
        let addr = "/live/clip/get/notes";
        let args = vec![OscType::Int(1), OscType::Int(0)];

        let owner_id = {
            let mut t = table.lock().unwrap();
            match t.register(Instant::now(), addr, &args) {
                Registration::New(id) => id,
                other => panic!("expected New, got {other:?}"),
            }
        };

        let joined_err = q
            .query(addr, args.clone(), Duration::from_millis(50))
            .await
            .unwrap_err();
        assert_eq!(joined_err, QueryError::NoReply);

        let still_pending = {
            let mut t = table.lock().unwrap();
            t.register(Instant::now(), addr, &args)
        };
        assert_eq!(still_pending, Registration::Joined(owner_id));
    }

    #[tokio::test]
    async fn an_occupied_unkeyed_address_reports_busy_without_sending_a_second_datagram() {
        // mixer_data's reply echoes no range, so two in flight cannot be told
        // apart. A query must wait for the slot, never race for it.
        let (live, q, table, _port) = fixture().await;
        {
            let mut t = table.lock().unwrap();
            t.register(
                Instant::now(),
                "/live/track/get/mixer_data",
                &[OscType::Int(0), OscType::Int(-1)],
            );
        }

        let err = q
            .query(
                "/live/track/get/mixer_data",
                vec![OscType::Int(0), OscType::Int(-1)],
                Duration::from_millis(150),
            )
            .await
            .unwrap_err();
        assert_eq!(err, QueryError::Busy);

        let nothing = tokio::time::timeout(Duration::from_millis(50), live.recv()).await;
        assert!(nothing.is_err(), "no datagram may go out while the slot is occupied");
    }
}
