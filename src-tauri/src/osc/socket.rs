use rosc::{decoder, encoder, OscMessage, OscPacket};
pub use rosc::OscType;
use std::net::SocketAddr;
use tokio::net::UdpSocket;

/// The Remote Script listens here and replies to us on the port we bind.
pub const LIVE_RECV_PORT: u16 = 11000;
pub const CLIENT_PORT: u16 = 11001;

pub struct OscSocket {
    socket: UdpSocket,
    remote_port: u16,
}

impl OscSocket {
    pub async fn bind() -> std::io::Result<Self> {
        Self::bind_to(CLIENT_PORT, LIVE_RECV_PORT).await
    }

    pub async fn bind_to(local_port: u16, remote_port: u16) -> std::io::Result<Self> {
        let addr: SocketAddr = format!("127.0.0.1:{local_port}").parse().unwrap();
        let socket = UdpSocket::bind(addr).await?;
        Ok(Self { socket, remote_port })
    }

    pub fn local_port(&self) -> u16 {
        self.socket.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    pub async fn send(&self, addr: &str, args: Vec<OscType>) -> std::io::Result<()> {
        self.send_to(self.remote_port, addr, args).await
    }

    pub async fn send_to(
        &self,
        port: u16,
        addr: &str,
        args: Vec<OscType>,
    ) -> std::io::Result<()> {
        let packet = OscPacket::Message(OscMessage {
            addr: addr.to_string(),
            args,
        });
        let bytes = encoder::encode(&packet)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        let dest: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        self.socket.send_to(&bytes, dest).await?;
        Ok(())
    }

    /// Exactly one task may await `recv` at a time. Tokio's `UdpSocket` keeps
    /// only the most recent `Waker` for the recv direction, so a second
    /// concurrent caller silently steals the wakeup slot and can starve the
    /// first, indefinitely, without ever corrupting a datagram. By contrast,
    /// `send`/`send_to` are safe to call concurrently from multiple
    /// `Arc<OscSocket>` holders — the write direction has its own waker slot.
    pub async fn recv(&self) -> std::io::Result<OscMessage> {
        // 9216 is the macOS maxdgram ceiling; anything Live can send fits.
        // Allocated fresh per call, deliberately kept simple; if the receive
        // path ever shows up in profiling, look here first.
        let mut buf = vec![0u8; 9216];
        let (len, _) = self.socket.recv_from(&mut buf).await?;
        let (_, packet) = decoder::decode_udp(&buf[..len])
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        match packet {
            OscPacket::Message(m) => Ok(m),
            OscPacket::Bundle(_) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bundles are not used by the Remote Script",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn encodes_and_decodes_a_round_trip() {
        // Bind two sockets to loopback and speak OSC between them, so the test
        // exercises the real encoder, the real decoder, and a real datagram.
        let a = OscSocket::bind_to(0, 0).await.unwrap();
        let b = OscSocket::bind_to(0, 0).await.unwrap();

        a.send_to(b.local_port(), "/live/song/get/tempo", vec![OscType::Float(128.0)])
            .await
            .unwrap();

        let msg = b.recv().await.unwrap();
        assert_eq!(msg.addr, "/live/song/get/tempo");
        assert_eq!(msg.args, vec![OscType::Float(128.0)]);
    }
}
