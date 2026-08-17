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
                Registration::New(_) => self
                    .socket
                    .send(addr, args.clone())
                    .await
                    .map_err(|e| QueryError::Transport(e.to_string()))?,
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

            let rx = rx.expect("New and Joined always produce a receiver");
            let remaining = deadline.saturating_duration_since(Instant::now());
            return match tokio::time::timeout(remaining, rx).await {
                Ok(Ok(reply)) => Ok(reply),
                // The channel closed: `expire` reclaimed the slot and
                // dropped the waiter. Same outcome as running out of time.
                Ok(Err(_)) | Err(_) => Err(QueryError::NoReply),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;

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
        let (_live, q, _table, _port) = fixture().await;
        let err = q
            .query(
                "/live/clip/get/length",
                vec![OscType::Int(1), OscType::Int(0)],
                Duration::from_millis(120),
            )
            .await
            .unwrap_err();
        assert_eq!(err, QueryError::NoReply);
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
