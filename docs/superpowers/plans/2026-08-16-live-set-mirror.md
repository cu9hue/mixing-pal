# Live Set Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app that connects to Ableton Live through a vendored Remote Script and displays an accurate, continuously updating view of the open set.

**Architecture:** A vendored fork of AbletonOSC runs inside Live and speaks OSC over UDP. A thin Rust layer owns the socket, a single-flight request table, subscriptions to index-free objects, and byte-budgeted polling of everything indexed. It coalesces observations into deltas and pushes them to a TypeScript webview that holds the set model and renders it. No language model is involved anywhere in this plan.

**Tech Stack:** Rust (Tauri v2, `rosc`, `tokio`, `serde`), TypeScript (React, Vite, Vitest), Python 3 (the Remote Script fork, running inside Live's interpreter).

**Spec:** `docs/superpowers/specs/2026-08-15-ableton-copilot-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Target host:** Ableton Live 12.2.5 Suite, macOS.
- **Ports:** the Remote Script listens on UDP **11000**, replies on UDP **11001**, both on `127.0.0.1`.
- **Datagram cap:** `net.inet.udp.maxdgram` is **9216 bytes** on the target machine. Exceeding it makes `sendto` raise inside Live and the client receives *nothing* — hard failure, not truncation. Every bulk query is budgeted in **bytes, not object counts**.
- **Never subscribe to an indexed object.** `start_listen` is permitted only for `/live/song/...` and `/live/view/...`. Subscribing to anything carrying a track, clip, device, or parameter index is forbidden — targeted `stop_listen` leaks the underlying LOM listener permanently. See the spec's "Targeted `stop_listen` leaks the listener".
- **Never use `/live/song/start_listen/current_song_time`.** Use `/live/song/start_listen/beat`.
- **Poll rates:** track state 2 s, faders 2 s, selection 1 s, focused-clip notes 1.5 s, meters 2 s.
- **Delta coalescing:** 250 ms.
- **Read-only.** No task in this plan sends any `/live/*/set/*` or `/live/*/add/*` or `/live/*/remove/*` message.
- **The fork is pinned by commit** and vendored in-repo. It is never fetched at runtime.

---

## File Structure

```
remote-script/AbletonCopilot/       # shipped to ~/Music/Ableton/User Library/Remote Scripts/
  __init__.py                       # entry point, registers handlers
  UPSTREAM                          # pinned upstream commit hash + provenance note
  abletonosc/                       # vendored upstream, unmodified
  copilot/
    master.py                       # master + return track handler      (Task 2)
    mixer.py                        # faders in track_data, dB strings   (Task 3)
    device_range.py                 # ranged device parameter queries    (Task 3)

src-tauri/src/
  main.rs                           # window config, app wiring          (Task 1)
  osc/mod.rs                        # module root
  osc/socket.rs                     # UDP + rosc codec                   (Task 4)
  osc/arity.rs                      # endpoint key-arity map             (Task 5)
  osc/requests.rs                   # single-flight table, generations   (Task 6)
  osc/budget.rs                     # byte budgeting and paging          (Task 7)
  osc/subs.rs                       # singleton subscriptions            (Task 8)
  osc/pollers.rs                    # indexed-state polling              (Task 8)
  deltas.rs                         # coalescing + Tauri events          (Task 9)

src/
  live/model.ts                     # set state types                    (Task 10)
  live/apply.ts                     # delta application                  (Task 10)
  live/notes.ts                     # note diffing + identity reset      (Task 10)
  ui/SetView.tsx                    # the window                         (Task 11)
  ui/Connection.tsx                 # connection banner                  (Task 11)
```

One responsibility per file. `requests.rs` and `budget.rs` hold the two bug classes the reviews found, so both are isolated and heavily tested.

---

### Task 1: Scaffold the app and vendor the fork

Proves the whole chain end to end before any real logic exists: Rust sends one OSC message, Live answers, the value reaches stdout.

**Files:**
- Create: `src-tauri/`, `src/`, `package.json`, `src-tauri/Cargo.toml` (via scaffold)
- Create: `remote-script/AbletonCopilot/UPSTREAM`
- Create: `remote-script/AbletonCopilot/abletonosc/` (vendored)
- Create: `scripts/install-remote-script.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a Tauri v2 project that builds, and an installed Remote Script named `AbletonCopilot` selectable in Live.

- [ ] **Step 1: Scaffold the Tauri app**

```bash
npm create tauri-app@latest -- --yes \
  --name ableton-copilot \
  --template react-ts \
  --manager npm \
  --directory .
npm install
```

- [ ] **Step 2: Add Rust dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
rosc = "0.11"
tokio = { version = "1", features = ["net", "sync", "time", "rt-multi-thread", "macros"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 3: Vendor upstream AbletonOSC at a pinned commit**

```bash
mkdir -p remote-script
git clone https://github.com/ideoforms/AbletonOSC /tmp/abletonosc-src
cd /tmp/abletonosc-src && git rev-parse HEAD > /tmp/pinned-sha && cd -
mkdir -p remote-script/AbletonCopilot
cp -R /tmp/abletonosc-src/abletonosc remote-script/AbletonCopilot/abletonosc
cp /tmp/abletonosc-src/__init__.py remote-script/AbletonCopilot/__init__.py
cp -R /tmp/abletonosc-src/pythonosc remote-script/AbletonCopilot/pythonosc
```

Write `remote-script/AbletonCopilot/UPSTREAM` with the pinned SHA:

```
Upstream: https://github.com/ideoforms/AbletonOSC
Pinned commit: <contents of /tmp/pinned-sha>
Vendored: 2026-08-16

The `abletonosc/` and `pythonosc/` directories are unmodified upstream code.
Our additions live in `copilot/`. Do not edit vendored files in place; add a
handler in `copilot/` and register it from `__init__.py` instead.
```

- [ ] **Step 4: Write the installer script**

Create `scripts/install-remote-script.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST="$HOME/Music/Ableton/User Library/Remote Scripts/AbletonCopilot"
SRC="$(cd "$(dirname "$0")/../remote-script/AbletonCopilot" && pwd)"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "Installed to $DEST"
echo "Restart Live, then choose AbletonCopilot under"
echo "Preferences > Link/Tempo/MIDI > Control Surface."
```

Then: `chmod +x scripts/install-remote-script.sh && ./scripts/install-remote-script.sh`

- [ ] **Step 5: Verify the round trip by hand**

Restart Live, select `AbletonCopilot` as a Control Surface, open any set, then:

```bash
python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('127.0.0.1', 11001))
s.settimeout(3)
# minimal OSC message: address, padded, then ',' typetag
s.sendto(b'/live/song/get/tempo\x00\x00\x00\x00,\x00\x00\x00', ('127.0.0.1', 11000))
print(s.recvfrom(1024))
"
```

Expected: a datagram containing `/live/song/get/tempo` and your set's BPM. If it times out, the Control Surface is not selected or Live was not restarted.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold Tauri app and vendor pinned AbletonOSC fork"
```

---

### Task 2: Fork — reach the master and return tracks

Upstream resolves every track through `song.tracks`, which excludes master and returns. Without this the master row and the master level rule have no data source at all.

**Files:**
- Create: `remote-script/AbletonCopilot/copilot/__init__.py`
- Create: `remote-script/AbletonCopilot/copilot/master.py`
- Modify: `remote-script/AbletonCopilot/__init__.py`

**Interfaces:**
- Consumes: `AbletonOSCHandler` from the vendored `abletonosc.handler`.
- Produces: OSC endpoints `/live/master/get/<prop>` (no index argument) and `/live/return/get/<prop> <return_index>`, where `<prop>` covers `volume`, `panning`, `output_meter_level`, `name`. Replies echo no index for master, and `return_index` for returns.

- [ ] **Step 1: Write the handler**

Create `remote-script/AbletonCopilot/copilot/master.py`:

```python
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class MasterHandler(AbletonOSCHandler):
    """Exposes song.master_track, which upstream cannot reach because every
    /live/track/* endpoint resolves through song.tracks (which excludes it)."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "master"

    def init_api(self):
        def mixer_get(prop):
            def handler(params: Tuple[Any] = ()):
                track = self.song.master_track
                return (getattr(track.mixer_device, prop).value,)
            return handler

        def name_get(params: Tuple[Any] = ()):
            return (self.song.master_track.name,)

        def meter_get(params: Tuple[Any] = ()):
            return (self.song.master_track.output_meter_level,)

        for prop in ("volume", "panning"):
            self.osc_server.add_handler(
                "/live/master/get/%s" % prop, mixer_get(prop))

        self.osc_server.add_handler("/live/master/get/name", name_get)
        self.osc_server.add_handler(
            "/live/master/get/output_meter_level", meter_get)


class ReturnHandler(AbletonOSCHandler):
    """Same gap for song.return_tracks."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "return"

    def init_api(self):
        def mixer_get(prop):
            def handler(params: Tuple[Any]):
                index = int(params[0])
                track = self.song.return_tracks[index]
                return (index, getattr(track.mixer_device, prop).value)
            return handler

        def name_get(params: Tuple[Any]):
            index = int(params[0])
            return (index, self.song.return_tracks[index].name)

        def count_get(params: Tuple[Any] = ()):
            return (len(self.song.return_tracks),)

        for prop in ("volume", "panning"):
            self.osc_server.add_handler(
                "/live/return/get/%s" % prop, mixer_get(prop))

        self.osc_server.add_handler("/live/return/get/name", name_get)
        self.osc_server.add_handler("/live/return/get/num_returns", count_get)
```

Create `remote-script/AbletonCopilot/copilot/__init__.py`:

```python
from .master import MasterHandler, ReturnHandler

__all__ = ["MasterHandler", "ReturnHandler"]
```

- [ ] **Step 2: Register the handlers**

Open `remote-script/AbletonCopilot/__init__.py` and find where upstream instantiates its handlers (a list of `...Handler(self)` constructions inside the manager class). Add ours alongside them:

```python
from .copilot import MasterHandler, ReturnHandler
```

and in the same list that constructs `TrackHandler(self)`:

```python
MasterHandler(self),
ReturnHandler(self),
```

- [ ] **Step 3: Reinstall and restart Live**

```bash
./scripts/install-remote-script.sh
```

Quit and reopen Live. Handlers register at script load, so a restart is required.

- [ ] **Step 4: Verify against real Live**

This code runs inside Live's embedded Python against live LOM objects. There is no way to unit test it outside Live, so verification is manual and must actually be performed — do not mark this step done without running it.

```bash
python3 - <<'EOF'
import socket, struct
def osc(addr, args=()):
    def pad(b): return b + b'\x00' * (4 - len(b) % 4)
    msg = pad(addr.encode())
    tags = ',' + ''.join('i' if isinstance(a, int) else 'f' for a in args)
    msg += pad(tags.encode())
    for a in args:
        msg += struct.pack('>i' if isinstance(a, int) else '>f', a)
    return msg
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('127.0.0.1', 11001)); s.settimeout(3)
for addr, args in [("/live/master/get/volume", ()),
                   ("/live/master/get/output_meter_level", ()),
                   ("/live/return/get/num_returns", ())]:
    s.sendto(osc(addr, args), ('127.0.0.1', 11000))
    print(addr, s.recvfrom(2048)[0])
EOF
```

Expected: three replies. `volume` is a float near 0.85 at unity. `output_meter_level` is 0.0 when stopped and rises during playback. `num_returns` matches the return track count in your set (add a return track and re-run to confirm it changes).

- [ ] **Step 5: Commit**

```bash
git add remote-script
git commit -m "feat(fork): reach master and return tracks"
```

---

### Task 3: Fork — faders in bulk, dB strings, and ranged device queries

Three gaps in one file group. `track_data` does `getattr(track, prop)`, so `track.volume` raises because volume lives on `mixer_device`. Nothing anywhere returns a dB string. Device parameter queries have no ranged form, so a Rack can overflow the datagram cap.

**Files:**
- Create: `remote-script/AbletonCopilot/copilot/mixer.py`
- Create: `remote-script/AbletonCopilot/copilot/device_range.py`
- Modify: `remote-script/AbletonCopilot/copilot/__init__.py`
- Modify: `remote-script/AbletonCopilot/__init__.py`

**Interfaces:**
- Consumes: `AbletonOSCHandler`.
- Produces:
  - `/live/track/get/volume_db <track_index>` → `(track_index, str)` e.g. `"-6.0 dB"`
  - `/live/master/get/volume_db` → `(str,)`
  - `/live/track/get/mixer_data <index_min> <index_max>` → flat list of `(volume, panning)` floats per track, in index order. Keyless, like `track_data`.
  - `/live/device/get/parameters/value_range <track> <device> <param_start> <param_span>` → `(track, device, param_start, value, value, ...)`

- [ ] **Step 1: Write the mixer handler**

Create `remote-script/AbletonCopilot/copilot/mixer.py`:

```python
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class MixerHandler(AbletonOSCHandler):
    """track_data cannot fetch faders because song.py does getattr(track, prop)
    and volume/panning live on track.mixer_device. Also exposes the formatted
    dB string, which the LOM has on the volume DeviceParameter but upstream
    never surfaces."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "mixer"

    def init_api(self):
        def track_volume_db(params: Tuple[Any]):
            index = int(params[0])
            param = self.song.tracks[index].mixer_device.volume
            return (index, str(param))

        def master_volume_db(params: Tuple[Any] = ()):
            return (str(self.song.master_track.mixer_device.volume),)

        def mixer_data(params: Tuple[Any]):
            index_min, index_max = int(params[0]), int(params[1])
            if index_max == -1:
                index_max = len(self.song.tracks)
            rv = []
            for i in range(index_min, index_max):
                mixer = self.song.tracks[i].mixer_device
                rv.append(mixer.volume.value)
                rv.append(mixer.panning.value)
            return tuple(rv)

        self.osc_server.add_handler(
            "/live/track/get/volume_db", track_volume_db)
        self.osc_server.add_handler(
            "/live/master/get/volume_db", master_volume_db)
        self.osc_server.add_handler(
            "/live/track/get/mixer_data", mixer_data)
```

- [ ] **Step 2: Write the ranged device parameter handler**

Create `remote-script/AbletonCopilot/copilot/device_range.py`:

```python
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class DeviceRangeHandler(AbletonOSCHandler):
    """Upstream returns every parameter in one datagram. An Instrument Rack can
    exceed 1000 parameters, which blows past the 9216-byte macOS UDP cap and
    makes sendto raise, so the client receives nothing at all. This mirrors the
    ranged form that clip note queries already have."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "device"

    def init_api(self):
        def params_for(track_index, device_index):
            return self.song.tracks[track_index].devices[device_index].parameters

        def value_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            all_params = params_for(track_index, device_index)
            window = list(all_params)[start:start + span]
            values = [p.value for p in window]
            return (track_index, device_index, start, *values)

        def name_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            all_params = params_for(track_index, device_index)
            window = list(all_params)[start:start + span]
            names = [p.name for p in window]
            return (track_index, device_index, start, *names)

        def value_string_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            all_params = params_for(track_index, device_index)
            window = list(all_params)[start:start + span]
            strings = [str(p) for p in window]
            return (track_index, device_index, start, *strings)

        self.osc_server.add_handler(
            "/live/device/get/parameters/value_range", value_range)
        self.osc_server.add_handler(
            "/live/device/get/parameters/name_range", name_range)
        self.osc_server.add_handler(
            "/live/device/get/parameters/value_string_range", value_string_range)
```

- [ ] **Step 3: Register both handlers**

In `remote-script/AbletonCopilot/copilot/__init__.py`:

```python
from .master import MasterHandler, ReturnHandler
from .mixer import MixerHandler
from .device_range import DeviceRangeHandler

__all__ = [
    "MasterHandler", "ReturnHandler", "MixerHandler", "DeviceRangeHandler",
]
```

In `remote-script/AbletonCopilot/__init__.py`, extend the import and add to the same handler list as Task 2:

```python
MixerHandler(self),
DeviceRangeHandler(self),
```

- [ ] **Step 4: Reinstall, restart Live, and verify**

```bash
./scripts/install-remote-script.sh
```

Restart Live. Set a track's fader to exactly 0 dB, put an Instrument Rack on another track, then run the Task 2 verification harness with these addresses:

- `/live/track/get/volume_db 0` — expect a string like `"0.0 dB"` matching what Live displays.
- `/live/track/get/mixer_data 0 -1` — expect two floats per track, in order.
- `/live/device/get/parameters/value_range 1 0 0 32` — expect 32 values, and confirm a second call with start `32` returns the next window rather than repeating.

Confirm the Rack's full parameter count from `/live/device/get/num_parameters 1 0`, then verify that requesting the whole range at once still works only below the byte cap — this is the failure the ranged form exists to avoid.

- [ ] **Step 5: Commit**

```bash
git add remote-script
git commit -m "feat(fork): bulk faders, dB strings, ranged device parameter queries"
```

---

### Task 4: Rust — UDP socket and OSC codec

**Files:**
- Create: `src-tauri/src/osc/mod.rs`
- Create: `src-tauri/src/osc/socket.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct OscSocket` with `pub async fn bind() -> std::io::Result<Self>`, `pub async fn send(&self, addr: &str, args: Vec<OscType>) -> std::io::Result<()>`, and `pub async fn recv(&self) -> std::io::Result<OscMessage>`.
  - Re-exports `rosc::OscType` and `rosc::OscMessage` for later tasks.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/osc/socket.rs` with the test module only:

```rust
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd src-tauri && cargo test osc::socket`
Expected: FAIL — `cannot find type OscSocket in this scope`.

- [ ] **Step 3: Implement the socket**

Prepend to `src-tauri/src/osc/socket.rs`:

```rust
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

    pub async fn recv(&self) -> std::io::Result<OscMessage> {
        // 9216 is the macOS maxdgram ceiling; anything Live can send fits.
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
```

Create `src-tauri/src/osc/mod.rs`:

```rust
pub mod socket;
```

Add to `src-tauri/src/main.rs`, above `fn main`:

```rust
mod osc;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd src-tauri && cargo test osc::socket`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(osc): UDP socket and OSC codec"
```

---

### Task 5: Rust — the endpoint key-arity map

Reply key width varies per endpoint. One wrong entry silently resolves a query for one object with another object's reply, so this gets its own file and an exhaustive test.

**Files:**
- Create: `src-tauri/src/osc/arity.rs`
- Modify: `src-tauri/src/osc/mod.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum KeyArity { None, Args(usize), Unkeyed }` and `pub fn key_arity(addr: &str) -> KeyArity`.
  - `None` — reply carries no key; the address alone identifies the request (song and view properties).
  - `Args(n)` — the first `n` reply arguments are the key.
  - `Unkeyed` — request arguments vary but the reply echoes nothing, so these must be serialized one at a time.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/osc/arity.rs` with the test module only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_endpoint_the_design_uses() {
        // Each line is a load-bearing claim about how many leading reply args
        // are the key. A wrong entry cross-resolves queries between objects.
        let cases: &[(&str, KeyArity)] = &[
            ("/live/song/get/tempo", KeyArity::None),
            ("/live/song/get/is_playing", KeyArity::None),
            ("/live/song/get/scale_name", KeyArity::None),
            ("/live/song/get/num_tracks", KeyArity::None),
            ("/live/song/get/num_scenes", KeyArity::None),
            ("/live/view/get/selected_track", KeyArity::None),
            ("/live/view/get/selected_scene", KeyArity::None),
            ("/live/view/get/selected_clip", KeyArity::None),
            ("/live/view/get/selected_device", KeyArity::None),
            ("/live/master/get/volume", KeyArity::None),
            ("/live/master/get/output_meter_level", KeyArity::None),
            ("/live/track/get/name", KeyArity::Args(1)),
            ("/live/track/get/volume", KeyArity::Args(1)),
            ("/live/track/get/volume_db", KeyArity::Args(1)),
            ("/live/track/get/output_meter_level", KeyArity::Args(1)),
            ("/live/track/get/clips/name", KeyArity::Args(1)),
            ("/live/track/get/arrangement_clips/name", KeyArity::Args(1)),
            ("/live/track/get/send", KeyArity::Args(2)),
            ("/live/return/get/name", KeyArity::Args(1)),
            ("/live/clip/get/notes", KeyArity::Args(2)),
            ("/live/clip/get/length", KeyArity::Args(2)),
            ("/live/device/get/name", KeyArity::Args(2)),
            ("/live/device/get/num_parameters", KeyArity::Args(2)),
            ("/live/device/get/parameter/value_string", KeyArity::Args(3)),
            ("/live/device/get/parameters/value_range", KeyArity::Args(3)),
            // Keyless: args vary between requests but the reply echoes nothing.
            ("/live/song/get/track_data", KeyArity::Unkeyed),
            ("/live/song/get/track_names", KeyArity::Unkeyed),
            ("/live/track/get/mixer_data", KeyArity::Unkeyed),
        ];
        for (addr, expected) in cases {
            assert_eq!(key_arity(addr), *expected, "wrong arity for {addr}");
        }
    }

    #[test]
    fn unknown_addresses_are_rejected_loudly() {
        // Defaulting an unknown address to a guess is how cross-resolution bugs
        // get in. Anything not in the map must be a hard failure.
        assert_eq!(key_arity("/live/track/get/invented"), KeyArity::Unknown);
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd src-tauri && cargo test osc::arity`
Expected: FAIL — `cannot find function key_arity`.

- [ ] **Step 3: Implement the map**

Prepend to `src-tauri/src/osc/arity.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyArity {
    /// The address alone identifies the request.
    None,
    /// The first n reply arguments are the key.
    Args(usize),
    /// Request args vary, reply echoes nothing. Must be serialized.
    Unkeyed,
    /// Not a known endpoint. Never guess.
    Unknown,
}

pub fn key_arity(addr: &str) -> KeyArity {
    match addr {
        "/live/song/get/track_data"
        | "/live/song/get/track_names"
        | "/live/track/get/mixer_data" => KeyArity::Unkeyed,

        "/live/device/get/parameter/value_string"
        | "/live/device/get/parameters/value_range"
        | "/live/device/get/parameters/name_range"
        | "/live/device/get/parameters/value_string_range" => KeyArity::Args(3),

        "/live/track/get/send" => KeyArity::Args(2),

        _ if addr.starts_with("/live/clip/get/") => KeyArity::Args(2),
        _ if addr.starts_with("/live/device/get/") => KeyArity::Args(2),
        _ if addr.starts_with("/live/track/get/") => KeyArity::Args(1),
        _ if addr.starts_with("/live/return/get/") => KeyArity::Args(1),

        _ if addr.starts_with("/live/song/get/") => KeyArity::None,
        _ if addr.starts_with("/live/view/get/") => KeyArity::None,
        _ if addr.starts_with("/live/master/get/") => KeyArity::None,

        _ => KeyArity::Unknown,
    }
}
```

Add `pub mod arity;` to `src-tauri/src/osc/mod.rs`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd src-tauri && cargo test osc::arity`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(osc): endpoint key-arity map"
```

---

### Task 6: Rust — single-flight request table with generation guard

The core protocol component. Subscription updates and query replies share addresses, so every inbound packet is an observation first and a promise resolution second.

**Files:**
- Create: `src-tauri/src/osc/requests.rs`
- Modify: `src-tauri/src/osc/mod.rs`

**Interfaces:**
- Consumes: `KeyArity` and `key_arity` from Task 5; `OscMessage`, `OscType` from Task 4.
- Produces:
  - `pub struct RequestTable` with `pub fn new() -> Self`.
  - `pub fn register(&mut self, addr: &str, args: &[OscType]) -> Registration` where `Registration` is `New(RequestId)` or `Joined(RequestId)` (single-flight) or `Deferred` (an `Unkeyed` request is already outstanding).
  - `pub fn resolve(&mut self, msg: &OscMessage) -> Resolution` returning `Resolution { observation: bool, completed: Option<RequestId> }`. `observation` is always `true` — every packet updates the mirror regardless of whether it completed a request.
  - `pub fn bump_generation(&mut self) -> Vec<RequestId>` cancels and returns every in-flight request.
  - `pub fn expire(&mut self, now: Instant, timeout: Duration) -> Vec<RequestId>`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/osc/requests.rs` with the test module only:

```rust
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
    fn a_zombie_reply_is_indistinguishable_and_resolves_the_current_request() {
        // Timeline: request track 3's volume, a track is deleted, the world is
        // regenerated, a new request for track 3 goes out. The late reply from
        // the dead request carries the OLD track's value — and is byte-identical
        // to a legitimate reply in every field the table keys on. UDP carries no
        // request ID and nothing stamps the generation onto the wire, so this
        // layer CANNOT reject it. bump_generation cancels the table ENTRY, never
        // the packet already in flight. Containment lives elsewhere: nothing
        // reads a resolved value, the genuine reply that follows is still an
        // observation and overwrites the stale one, and polling re-corrects
        // within one cycle.
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
}
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd src-tauri && cargo test osc::requests`
Expected: FAIL — `cannot find type RequestTable`.

- [ ] **Step 3: Implement the table**

Prepend to `src-tauri/src/osc/requests.rs`:

```rust
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
```

Add `pub mod requests;` to `src-tauri/src/osc/mod.rs`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd src-tauri && cargo test osc::requests`
Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(osc): single-flight request table with generation guard"
```

---

### Task 7: Rust — byte budgeting and paging

Object counts do not predict datagram size. This file converts every bulk query into windows that fit under the cap.

**Files:**
- Create: `src-tauri/src/osc/budget.rs`
- Modify: `src-tauri/src/osc/mod.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub const MAX_DATAGRAM: usize = 9216;`
  - `pub fn note_windows(clip_length_beats: f32, est_notes: usize) -> Vec<(f32, f32)>` — `(time_start, time_span)` pairs covering the clip.
  - `pub fn param_windows(num_params: usize) -> Vec<(usize, usize)>` — `(start, span)` pairs.
  - `pub fn track_chunks(num_tracks: usize, num_scenes: usize, props_per_track: usize) -> Vec<(usize, usize)>` — `(index_min, index_max)` pairs.
  - `pub enum MissingReason { TooLarge, NoAnswer }`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/osc/budget.rs` with the test module only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_clip_needs_one_window() {
        let w = note_windows(16.0, 40);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0], (0.0, 16.0));
    }

    #[test]
    fn a_dense_clip_is_split_below_the_cap() {
        // 5 OSC values per note. 2000 notes cannot fit in 9216 bytes, so this
        // must page rather than produce one oversized request.
        let w = note_windows(64.0, 2000);
        assert!(w.len() > 1, "expected paging, got {} window(s)", w.len());
        // Windows must tile the clip with no gap and no overlap.
        assert_eq!(w[0].0, 0.0);
        for pair in w.windows(2) {
            let (start_a, span_a) = pair[0];
            let (start_b, _) = pair[1];
            assert!((start_a + span_a - start_b).abs() < 1e-3);
        }
        let (last_start, last_span) = *w.last().unwrap();
        assert!((last_start + last_span - 64.0).abs() < 1e-3);
    }

    #[test]
    fn a_rack_with_a_thousand_parameters_is_paged() {
        let w = param_windows(1000);
        assert!(w.len() > 1);
        assert_eq!(w[0].0, 0);
        let covered: usize = w.iter().map(|(_, span)| span).sum();
        assert_eq!(covered, 1000);
    }

    #[test]
    fn track_chunks_shrink_as_scene_count_grows() {
        // Clip segments are per scene, so a set with many scenes must take
        // fewer tracks per chunk. Chunking by a fixed track count is the bug
        // this replaces.
        let few = track_chunks(50, 8, 4);
        let many = track_chunks(50, 200, 4);
        assert!(
            many.len() > few.len(),
            "200 scenes should need more chunks than 8"
        );
        // Both must still cover every track exactly once.
        for chunks in [&few, &many] {
            assert_eq!(chunks[0].0, 0);
            assert_eq!(chunks.last().unwrap().1, 50);
        }
    }
}
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd src-tauri && cargo test osc::budget`
Expected: FAIL — `cannot find function note_windows`.

- [ ] **Step 3: Implement the budgeting**

Prepend to `src-tauri/src/osc/budget.rs`:

```rust
/// net.inet.udp.maxdgram on macOS. Exceeding it makes sendto raise inside
/// Live and the client receives nothing at all — hard failure, not truncation.
pub const MAX_DATAGRAM: usize = 9216;

/// Leave room for the address string, type tag string, and echoed key args.
const HEADER_SLACK: usize = 256;

/// Every OSC int/float is 4 bytes of payload plus 1 byte of type tag.
const BYTES_PER_VALUE: usize = 5;

/// /live/clip/get/notes returns pitch, start_time, duration, velocity, mute.
const VALUES_PER_NOTE: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissingReason {
    /// The reply exceeded the datagram cap, so Live could not send it.
    TooLarge,
    /// Live did not answer within the timeout.
    NoAnswer,
}

fn budget_values() -> usize {
    (MAX_DATAGRAM - HEADER_SLACK) / BYTES_PER_VALUE
}

fn even_split(total: usize, per_chunk: usize) -> Vec<(usize, usize)> {
    if total == 0 {
        return vec![];
    }
    let per_chunk = per_chunk.max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while start < total {
        let span = per_chunk.min(total - start);
        out.push((start, span));
        start += span;
    }
    out
}

pub fn note_windows(clip_length_beats: f32, est_notes: usize) -> Vec<(f32, f32)> {
    let max_notes = budget_values() / VALUES_PER_NOTE;
    if est_notes <= max_notes || clip_length_beats <= 0.0 {
        return vec![(0.0, clip_length_beats.max(0.0))];
    }
    // Split by time, not by note index — the query form is time-ranged.
    let parts = est_notes.div_ceil(max_notes);
    let span = clip_length_beats / parts as f32;
    (0..parts)
        .map(|i| (i as f32 * span, span))
        .collect()
}

pub fn param_windows(num_params: usize) -> Vec<(usize, usize)> {
    even_split(num_params, budget_values())
}

pub fn track_chunks(
    num_tracks: usize,
    num_scenes: usize,
    props_per_track: usize,
) -> Vec<(usize, usize)> {
    // Per track: its own properties, plus one clip value per scene per
    // clip-valued property. Scene count dominates on real sets.
    let values_per_track = props_per_track + num_scenes.max(1);
    let tracks_per_chunk = (budget_values() / values_per_track.max(1)).max(1);
    even_split(num_tracks, tracks_per_chunk)
        .into_iter()
        .map(|(start, span)| (start, start + span))
        .collect()
}
```

Add `pub mod budget;` to `src-tauri/src/osc/mod.rs`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd src-tauri && cargo test osc::budget`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(osc): byte-budgeted paging for notes, parameters, and track chunks"
```

---

### Task 8: Rust — singleton subscriptions and indexed polling

**Files:**
- Create: `src-tauri/src/osc/subs.rs`
- Create: `src-tauri/src/osc/pollers.rs`
- Modify: `src-tauri/src/osc/mod.rs`

**Interfaces:**
- Consumes: `OscSocket` (Task 4), `RequestTable` (Task 6), `track_chunks` and `note_windows` (Task 7).
- Produces:
  - `pub const SINGLETON_SUBSCRIPTIONS: &[&str]` — the exact addresses subscribed on connect.
  - `pub fn is_subscribable(addr: &str) -> bool` — false for anything indexed.
  - `pub struct PollSchedule` with `pub fn due(&self, now: Instant) -> Vec<PollKind>` and `pub fn mark(&mut self, kind: PollKind, now: Instant)`.
  - `pub enum PollKind { TrackState, Faders, Selection, FocusedNotes, Meters }`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/osc/subs.rs` with the test module only:

```rust
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
}
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd src-tauri && cargo test osc::subs`
Expected: FAIL — `cannot find value SINGLETON_SUBSCRIPTIONS`.

- [ ] **Step 3: Implement subscriptions**

Prepend to `src-tauri/src/osc/subs.rs`:

```rust
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

pub fn is_subscribable(addr: &str) -> bool {
    addr.starts_with("/live/song/") || addr.starts_with("/live/view/")
}
```

- [ ] **Step 4: Write the failing poll-schedule test**

Create `src-tauri/src/osc/pollers.rs` with the test module only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn each_poll_kind_fires_at_its_own_rate() {
        let start = Instant::now();
        let mut s = PollSchedule::new(start);

        // Nothing is due immediately after marking everything fresh.
        for kind in PollKind::all() {
            s.mark(kind, start);
        }
        assert!(s.due(start).is_empty());

        // Selection is 1s, notes 1.5s, track state and meters 2s.
        let at_1s = start + Duration::from_millis(1_050);
        assert_eq!(s.due(at_1s), vec![PollKind::Selection]);

        let at_1_5s = start + Duration::from_millis(1_550);
        let due = s.due(at_1_5s);
        assert!(due.contains(&PollKind::Selection));
        assert!(due.contains(&PollKind::FocusedNotes));
        assert!(!due.contains(&PollKind::TrackState));

        let at_2s = start + Duration::from_millis(2_050);
        let due = s.due(at_2s);
        assert!(due.contains(&PollKind::TrackState));
        assert!(due.contains(&PollKind::Faders));
        assert!(due.contains(&PollKind::Meters));
    }
}
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `cd src-tauri && cargo test osc::pollers`
Expected: FAIL — `cannot find type PollSchedule`.

- [ ] **Step 6: Implement the schedule**

Prepend to `src-tauri/src/osc/pollers.rs`:

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PollKind {
    TrackState,
    Faders,
    Selection,
    FocusedNotes,
    Meters,
}

impl PollKind {
    pub fn all() -> Vec<PollKind> {
        vec![
            PollKind::TrackState,
            PollKind::Faders,
            PollKind::Selection,
            PollKind::FocusedNotes,
            PollKind::Meters,
        ]
    }

    /// Rates come from the spec and are not tunable at runtime.
    pub fn interval(&self) -> Duration {
        match self {
            PollKind::TrackState => Duration::from_secs(2),
            PollKind::Faders => Duration::from_secs(2),
            PollKind::Meters => Duration::from_secs(2),
            PollKind::Selection => Duration::from_secs(1),
            PollKind::FocusedNotes => Duration::from_millis(1_500),
        }
    }
}

pub struct PollSchedule {
    last: HashMap<PollKind, Instant>,
}

impl PollSchedule {
    pub fn new(now: Instant) -> Self {
        let mut last = HashMap::new();
        for kind in PollKind::all() {
            last.insert(kind, now);
        }
        Self { last }
    }

    pub fn due(&self, now: Instant) -> Vec<PollKind> {
        let mut due: Vec<PollKind> = PollKind::all()
            .into_iter()
            .filter(|k| {
                self.last
                    .get(k)
                    .map(|t| now.duration_since(*t) >= k.interval())
                    .unwrap_or(true)
            })
            .collect();
        due.sort_by_key(|k| format!("{k:?}"));
        due
    }

    pub fn mark(&mut self, kind: PollKind, now: Instant) {
        self.last.insert(kind, now);
    }
}
```

Add `pub mod subs;` and `pub mod pollers;` to `src-tauri/src/osc/mod.rs`.

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `cd src-tauri && cargo test osc::`
Expected: PASS, every test in the `osc` module.

- [ ] **Step 8: Commit**

```bash
git add src-tauri
git commit -m "feat(osc): singleton subscriptions and indexed poll schedule"
```

---

### Task 9: Rust — delta coalescing and the Tauri event bridge

**Files:**
- Create: `src-tauri/src/deltas.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `OscMessage` (Task 4).
- Produces:
  - `#[derive(Serialize)] pub struct Delta { pub addr: String, pub args: Vec<serde_json::Value> }`
  - `pub struct Coalescer` with `pub fn new() -> Self`, `pub fn observe(&mut self, msg: &OscMessage)`, `pub fn drain(&mut self) -> Vec<Delta>`.
  - Tauri event `live://deltas` carrying `Vec<Delta>`, emitted every 250 ms.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/deltas.rs` with the test module only:

```rust
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
}
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd src-tauri && cargo test deltas`
Expected: FAIL — `cannot find type Coalescer`.

- [ ] **Step 3: Implement the coalescer**

Prepend to `src-tauri/src/deltas.rs`:

```rust
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
        OscType::Float(f) => serde_json::json!(f),
        OscType::Double(f) => serde_json::json!(f),
        OscType::String(s) => serde_json::json!(s),
        OscType::Bool(b) => serde_json::json!(b),
        OscType::Nil => serde_json::Value::Null,
        other => serde_json::json!(format!("{other:?}")),
    }
}

pub struct Coalescer {
    /// Keyed by address plus the endpoint's key args, so two tracks never
    /// collapse into one another but repeated meter reads for one track do.
    latest: HashMap<String, Delta>,
    order: Vec<String>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self { latest: HashMap::new(), order: Vec::new() }
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

        if !self.latest.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.latest.insert(
            key,
            Delta {
                addr: msg.addr.clone(),
                args: msg.args.iter().map(to_json).collect(),
            },
        );
    }

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
}
```

Add `mod deltas;` to `src-tauri/src/main.rs`.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd src-tauri && cargo test deltas`
Expected: PASS, all three tests.

- [ ] **Step 5: Wire the run loop and window config**

In `src-tauri/src/main.rs`, replace the generated `main` with:

```rust
mod deltas;
mod osc;

use deltas::Coalescer;
use osc::socket::OscSocket;
use osc::subs::SINGLETON_SUBSCRIPTIONS;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let coalescer = Arc::new(Mutex::new(Coalescer::new()));

            // Receive loop: every packet is an observation.
            let recv_coalescer = coalescer.clone();
            tauri::async_runtime::spawn(async move {
                let socket = match OscSocket::bind().await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("failed to bind OSC socket: {e}");
                        return;
                    }
                };
                for addr in SINGLETON_SUBSCRIPTIONS {
                    let _ = socket.send(addr, vec![]).await;
                }
                loop {
                    match socket.recv().await {
                        Ok(msg) => {
                            if let Ok(mut c) = recv_coalescer.lock() {
                                c.observe(&msg);
                            }
                        }
                        Err(e) => eprintln!("osc recv error: {e}"),
                    }
                }
            });

            // Emit loop: one batch every 250 ms.
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                loop {
                    ticker.tick().await;
                    let batch = match coalescer.lock() {
                        Ok(mut c) => c.drain(),
                        Err(_) => continue,
                    };
                    if !batch.is_empty() {
                        let _ = handle.emit("live://deltas", batch);
                    }
                }
            });

            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(true)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Confirm it builds and emits**

Run: `npm run tauri dev`

With Live open and the Control Surface selected, change the tempo. Expected: the window opens, floats above other windows, and the webview console shows `live://deltas` batches arriving no more than four times per second.

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat: coalesce observations into 250ms delta batches"
```

---

### Task 10: TypeScript — set model, delta application, and note diffing

**Files:**
- Create: `src/live/model.ts`
- Create: `src/live/apply.ts`
- Create: `src/live/notes.ts`
- Create: `src/live/apply.test.ts`
- Create: `src/live/notes.test.ts`

**Interfaces:**
- Consumes: the `live://deltas` event payload from Task 9 — `Array<{ addr: string; args: unknown[] }>`.
- Produces:
  - `export interface SetState { tempo: number | null; isPlaying: boolean; scaleName: string | null; rootNote: number | null; selectedTrack: number | null; tracks: Record<number, TrackState>; }`
  - `export interface TrackState { name: string | null; volume: number | null; volumeDb: string | null; meter: number | null; }`
  - `export function emptySet(): SetState`
  - `export function applyDelta(state: SetState, delta: Delta): SetState` — pure, returns a new object.
  - `export interface Note { pitch: number; start: number; duration: number; velocity: number; mute: boolean }`
  - `export function diffNotes(prev: Note[], next: Note[]): { added: number; removed: number }`
  - `export class NoteTracker` with `update(clipId: string | null, notes: Note[]): { changed: boolean; added: number; removed: number }`

- [ ] **Step 1: Install the test runner**

```bash
npm install -D vitest
npm pkg set scripts.test="vitest run"
```

- [ ] **Step 2: Write the failing delta test**

Create `src/live/apply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emptySet, applyDelta } from "./apply";

describe("applyDelta", () => {
  it("stores song properties that carry no index", () => {
    const s = applyDelta(emptySet(), {
      addr: "/live/song/get/tempo",
      args: [128.0],
    });
    expect(s.tempo).toBe(128.0);
  });

  it("routes indexed track properties to the right track", () => {
    let s = emptySet();
    s = applyDelta(s, { addr: "/live/track/get/name", args: [0, "Kick"] });
    s = applyDelta(s, { addr: "/live/track/get/name", args: [1, "Bass"] });
    expect(s.tracks[0].name).toBe("Kick");
    expect(s.tracks[1].name).toBe("Bass");
  });

  it("does not mutate the state it was given", () => {
    const before = emptySet();
    const after = applyDelta(before, {
      addr: "/live/song/get/tempo",
      args: [140.0],
    });
    expect(before.tempo).toBeNull();
    expect(after.tempo).toBe(140.0);
  });

  it("ignores an unknown address rather than throwing", () => {
    const s = applyDelta(emptySet(), { addr: "/live/nonsense", args: [1] });
    expect(s).toEqual(emptySet());
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- src/live/apply.test.ts`
Expected: FAIL — cannot resolve `./apply`.

- [ ] **Step 4: Implement the model and delta application**

Create `src/live/model.ts`:

```ts
export interface TrackState {
  name: string | null;
  volume: number | null;
  volumeDb: string | null;
  meter: number | null;
}

export interface SetState {
  tempo: number | null;
  isPlaying: boolean;
  scaleName: string | null;
  rootNote: number | null;
  selectedTrack: number | null;
  tracks: Record<number, TrackState>;
}

export interface Delta {
  addr: string;
  args: unknown[];
}

export function emptyTrack(): TrackState {
  return { name: null, volume: null, volumeDb: null, meter: null };
}
```

Create `src/live/apply.ts`:

```ts
import { Delta, SetState, TrackState, emptyTrack } from "./model";

export function emptySet(): SetState {
  return {
    tempo: null,
    isPlaying: false,
    scaleName: null,
    rootNote: null,
    selectedTrack: null,
    tracks: {},
  };
}

const SONG_FIELDS: Record<string, keyof SetState> = {
  "/live/song/get/tempo": "tempo",
  "/live/song/get/is_playing": "isPlaying",
  "/live/song/get/scale_name": "scaleName",
  "/live/song/get/root_note": "rootNote",
  "/live/view/get/selected_track": "selectedTrack",
};

const TRACK_FIELDS: Record<string, keyof TrackState> = {
  "/live/track/get/name": "name",
  "/live/track/get/volume": "volume",
  "/live/track/get/volume_db": "volumeDb",
  "/live/track/get/output_meter_level": "meter",
};

export function applyDelta(state: SetState, delta: Delta): SetState {
  const songField = SONG_FIELDS[delta.addr];
  if (songField) {
    return { ...state, [songField]: delta.args[0] } as SetState;
  }

  const trackField = TRACK_FIELDS[delta.addr];
  if (trackField) {
    const index = delta.args[0] as number;
    const existing = state.tracks[index] ?? emptyTrack();
    return {
      ...state,
      tracks: {
        ...state.tracks,
        [index]: { ...existing, [trackField]: delta.args[1] },
      },
    };
  }

  return state;
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npm test -- src/live/apply.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 6: Write the failing note-tracker test**

Create `src/live/notes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NoteTracker, diffNotes, Note } from "./notes";

const note = (pitch: number, start: number): Note => ({
  pitch,
  start,
  duration: 0.5,
  velocity: 100,
  mute: false,
});

describe("diffNotes", () => {
  it("counts additions and removals", () => {
    const d = diffNotes([note(60, 0)], [note(60, 0), note(64, 1)]);
    expect(d).toEqual({ added: 1, removed: 0 });
  });
});

describe("NoteTracker", () => {
  it("reports a change when notes change within one clip", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    const r = t.update("2:0", [note(60, 0), note(67, 2)]);
    expect(r.changed).toBe(true);
    expect(r.added).toBe(1);
  });

  it("reports no change when the same notes are polled twice", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    expect(t.update("2:0", [note(60, 0)]).changed).toBe(false);
  });

  it("does not report a phantom edit when the focused clip changes", () => {
    // Selecting a different clip must reset the baseline. Otherwise the very
    // different note set of the new clip reads as a huge edit that never
    // happened, and that lands in the observation log as a lie.
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    const r = t.update("3:1", [note(48, 0), note(50, 1), note(52, 2)]);
    expect(r.changed).toBe(false);
  });

  it("resumes reporting changes after the reset", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    t.update("3:1", [note(48, 0)]);
    expect(t.update("3:1", [note(48, 0), note(55, 1)]).changed).toBe(true);
  });
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npm test -- src/live/notes.test.ts`
Expected: FAIL — cannot resolve `./notes`.

- [ ] **Step 8: Implement the note tracker**

Create `src/live/notes.ts`:

```ts
export interface Note {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

const keyOf = (n: Note) => `${n.pitch}:${n.start}:${n.duration}:${n.velocity}`;

export function diffNotes(
  prev: Note[],
  next: Note[],
): { added: number; removed: number } {
  const before = new Set(prev.map(keyOf));
  const after = new Set(next.map(keyOf));
  let added = 0;
  let removed = 0;
  after.forEach((k) => {
    if (!before.has(k)) added += 1;
  });
  before.forEach((k) => {
    if (!after.has(k)) removed += 1;
  });
  return { added, removed };
}

export class NoteTracker {
  private clipId: string | null = null;
  private notes: Note[] = [];

  update(
    clipId: string | null,
    notes: Note[],
  ): { changed: boolean; added: number; removed: number } {
    // A different clip is a new baseline, never an edit. Diffing across a
    // selection change would report an edit the producer never made.
    if (clipId !== this.clipId) {
      this.clipId = clipId;
      this.notes = notes;
      return { changed: false, added: 0, removed: 0 };
    }
    const { added, removed } = diffNotes(this.notes, notes);
    this.notes = notes;
    return { changed: added > 0 || removed > 0, added, removed };
  }
}
```

- [ ] **Step 9: Run the whole suite to confirm it passes**

Run: `npm test`
Expected: PASS, all tests in both files.

- [ ] **Step 10: Commit**

```bash
git add src package.json package-lock.json
git commit -m "feat(live): set model, delta application, and note diffing"
```

---

### Task 11: The window

**Files:**
- Create: `src/ui/Connection.tsx`
- Create: `src/ui/SetView.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SetState`, `emptySet`, `applyDelta` (Task 10); the `live://deltas` Tauri event (Task 9).
- Produces: the rendered window. Nothing downstream consumes it in this plan.

- [ ] **Step 1: Write the connection banner**

Create `src/ui/Connection.tsx`:

```tsx
export function Connection({ lastSeen }: { lastSeen: number | null }) {
  const stale = lastSeen === null || Date.now() - lastSeen > 5000;
  if (!stale) return null;
  return (
    <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
      Not connected to Live. Open a set and choose <b>AbletonCopilot</b> under
      Preferences → Link/Tempo/MIDI → Control Surface.
    </div>
  );
}
```

- [ ] **Step 2: Write the set view**

Create `src/ui/SetView.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Delta } from "../live/model";
import { emptySet, applyDelta } from "../live/apply";
import { Connection } from "./Connection";

export function SetView() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);

  useEffect(() => {
    const stop = listen<Delta[]>("live://deltas", (event) => {
      setState((prev) => event.payload.reduce(applyDelta, prev));
      setLastSeen(Date.now());
    });
    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div style={{ font: "13px ui-monospace, monospace", padding: 10 }}>
      <Connection lastSeen={lastSeen} />
      <div style={{ marginBottom: 8 }}>
        {state.tempo ?? "—"} BPM · {state.scaleName ?? "no scale"} ·{" "}
        {state.isPlaying ? "playing" : "stopped"}
      </div>
      <table>
        <tbody>
          {indices.map((i) => (
            <tr
              key={i}
              style={{
                fontWeight: state.selectedTrack === i ? "bold" : "normal",
              }}
            >
              <td style={{ paddingRight: 12 }}>{i}</td>
              <td style={{ paddingRight: 12 }}>{state.tracks[i].name ?? "—"}</td>
              <td>{state.tracks[i].volumeDb ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Mount it**

Replace the body of `src/App.tsx`:

```tsx
import { SetView } from "./ui/SetView";

export default function App() {
  return <SetView />;
}
```

- [ ] **Step 4: Run it against real Live**

Run: `npm run tauri dev`

Expected: the window floats above Live, shows the set's tempo and scale, and lists tracks. Change the tempo in Live — the window updates within about 250 ms. Quit Live — the red banner appears within about five seconds.

If the track list stays empty, that is expected at this point: track names arrive from the poll loop, which Task 12 wires up. The tempo and scale come from subscriptions and must already work.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(ui): always-on-top set view with connection banner"
```

---

### Task 12: Wire polling and verify against real Live

The final task connects the poll schedule to the socket, then runs the manual checklist the spec requires. Fixture replay cannot catch listener lifecycle bugs, UDP loss, or Live UI-thread stalls, so this must actually be performed.

**Files:**
- Modify: `src-tauri/src/main.rs`
- Create: `docs/manual-verification.md`

**Interfaces:**
- Consumes: `PollSchedule`, `PollKind` (Task 8); `RequestTable` (Task 6); `track_chunks` (Task 7); `OscSocket` (Task 4).
- Produces: a running poll loop. No new public API.

- [ ] **Step 1: Add the poll loop**

In `src-tauri/src/main.rs`, inside `setup`, add a third spawned task alongside the receive and emit loops. It needs its own socket handle, so change the receive loop to build the socket via `Arc` and share it:

```rust
use osc::pollers::{PollKind, PollSchedule};
use osc::requests::{RequestTable, Registration};
use osc::budget::track_chunks;
use rosc::OscType;
use std::time::Instant;

// inside setup(), after the socket is created and shared as `socket: Arc<OscSocket>`:
let poll_socket = socket.clone();
tauri::async_runtime::spawn(async move {
    let mut schedule = PollSchedule::new(Instant::now());
    let mut table = RequestTable::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        ticker.tick().await;
        let now = Instant::now();
        for kind in schedule.due(now) {
            match kind {
                PollKind::TrackState => {
                    // One keyless bulk call. Chunked by predicted byte size,
                    // never by a fixed track count.
                    for (min, max) in track_chunks(64, 8, 4) {
                        let args = vec![
                            OscType::Int(min as i32),
                            OscType::Int(max as i32),
                            OscType::String("track.name".into()),
                            OscType::String("track.mute".into()),
                            OscType::String("track.solo".into()),
                        ];
                        if let Registration::New(_) =
                            table.register("/live/song/get/track_data", &args)
                        {
                            let _ = poll_socket
                                .send("/live/song/get/track_data", args)
                                .await;
                        }
                    }
                }
                PollKind::Faders => {
                    let args = vec![OscType::Int(0), OscType::Int(-1)];
                    if let Registration::New(_) =
                        table.register("/live/track/get/mixer_data", &args)
                    {
                        let _ = poll_socket
                            .send("/live/track/get/mixer_data", args)
                            .await;
                    }
                }
                PollKind::Selection => {
                    for addr in [
                        "/live/view/get/selected_clip",
                        "/live/view/get/selected_device",
                    ] {
                        if let Registration::New(_) = table.register(addr, &[]) {
                            let _ = poll_socket.send(addr, vec![]).await;
                        }
                    }
                }
                PollKind::Meters => {
                    if let Registration::New(_) =
                        table.register("/live/master/get/output_meter_level", &[])
                    {
                        let _ = poll_socket
                            .send("/live/master/get/output_meter_level", vec![])
                            .await;
                    }
                }
                PollKind::FocusedNotes => {
                    // Wired in Plan 2, which owns the focused-clip digest.
                }
            }
            schedule.mark(kind, now);
        }
        // Requests that never came back must not block their key forever.
        table.expire(now, Duration::from_secs(2));
    }
});
```

- [ ] **Step 2: Confirm the whole suite still passes**

Run: `cd src-tauri && cargo test && cd .. && npm test`
Expected: PASS, every Rust and TypeScript test.

- [ ] **Step 3: Write the verification checklist**

Create `docs/manual-verification.md`:

```markdown
# Manual verification against real Live

Run before each release. Record the date and Live version.
Automated fixtures cannot catch listener lifecycle bugs, UDP loss, or
Live UI-thread stalls.

- [ ] Connect, resnapshot, confirm the displayed set matches Live.
- [ ] Add, delete, and reorder tracks. Confirm no state lands under the
      wrong track, and confirm no `start_listen` was ever sent to an
      indexed address (check Live's log at
      `~/Music/Ableton/User Library/Remote Scripts/AbletonCopilot/logs`).
- [ ] Change the selected track, clip, and device. Confirm focus follows
      and no phantom note edit is reported.
- [ ] Edit notes in the focused MIDI clip. Confirm the diff appears.
- [ ] Open a clip with 500+ notes. Confirm paging works rather than
      timing out, and that a dense clip never reports "no answer".
- [ ] Load a 50+ track set. Measure display update latency and Live's
      responsiveness. Benchmark at 20, 50, and 100 tracks.
- [ ] Restart Live mid-session. Confirm the app reconnects.
- [ ] Reload the webview. Confirm no orphaned subscriptions survive
      (Live's log must show no duplicate listener registrations).
```

- [ ] **Step 4: Run the checklist**

Perform every item against real Live. Any failure is a bug to fix before this plan is complete, not a note for later. Record results in the file.

- [ ] **Step 5: Commit**

```bash
git add src-tauri docs
git commit -m "feat: wire poll loop and add manual verification checklist"
```

---

## Self-Review

**Spec coverage.** Every spec section owned by this plan maps to a task: the vendored fork and its four gaps (Tasks 1–3), listener aliasing and the single-flight table (Task 6), the arity map (Task 5), keyless serialization and the generation guard (Task 6), the datagram budget (Task 7), singletons-only subscription and poll rates (Task 8), delta coalescing (Task 9), the set model (Task 10), the always-on-top window and connection banner (Task 11), and the manual checklist (Task 12).

Deliberately **not** in this plan, and carried to Plans 2 and 3: the digest and its 4k budget, the mixer summary extractor, session context, the model provider and agent loop, tools, untrusted-input fencing, and every nudge rule. `PollKind::FocusedNotes` is scheduled here but left unwired, with a comment pointing at Plan 2 — `NoteTracker` exists and is tested so Plan 2 only has to call it.

**Known gap to close in Plan 2.** Task 12 calls `track_chunks(64, 8, 4)` with hardcoded track and scene counts. Real values need `/live/song/get/num_tracks` and `/live/song/get/num_scenes` fetched before the first chunked call, which is also what parsing a `track_data` reply requires. Plan 2's first task does the snapshot sequencing properly; until then the poll loop over-requests on small sets and under-covers sets above 64 tracks.

**Types.** `Delta` is defined once in `src/live/model.ts` and matches the Rust `Delta` in `src-tauri/src/deltas.rs` field for field. `PollKind` is used identically in Tasks 8 and 12. `NoteTracker.update` has one signature, used only in its own tests here.

---

### Task 13: Decode the bulk replies so tracks actually appear

Added after Tasks 1-12 shipped. The poll loop sends `track_data` and `mixer_data`;
`applyDelta` only ever handled individual `/live/track/get/*` addresses; and no task
was assigned the parser between them. The result is that `state.tracks` stays `{}`
and the window renders zero track rows. This task closes that gap.

**The decode happens in Rust, not TypeScript.** Both replies are keyless — they echo
no range — so attributing one requires knowing which request is outstanding, and that
knowledge lives beside the request table. Rust decodes each bulk reply and re-emits it
as ordinary per-track deltas at the addresses `applyDelta` already understands, so the
tested TypeScript path is reused rather than duplicated.

**Reply shapes, verified against the vendored script:**
- `track_data` requests only `track.*` properties (`TRACK_DATA_PROPERTIES`), and
  `song.py` appends exactly one value per `track.` property per track. So the reply is
  `3 * (max - min)` values: `name, mute, solo` per track, in index order. Scene count
  does not affect it — that only applies to `clip.*` properties, which we never request.
- `mixer_data` (`copilot/mixer.py`) appends `volume, panning` per track: `2 * (max - min)`
  values, in index order.

**Files:**
- Modify: `src-tauri/src/lib.rs` (record in-flight ranges; decode on receipt)
- Create: `src-tauri/src/bulk.rs` (pure decoding, unit-tested)
- Modify: `src/live/model.ts` (`TrackState` gains `mute`, `solo`, `panning`)
- Modify: `src/live/apply.ts` (handle the re-emitted addresses)
- Modify: `src/ui/SetView.tsx` (render the new columns)

**Interfaces:**
- Consumes: `Delta` (Task 9), `RequestTable` (Task 6), `TrackState`/`applyDelta` (Task 10).
- Produces: `pub fn decode_track_data(range: (u32, u32), args: &[OscType]) -> Vec<Delta>`
  and `pub fn decode_mixer_data(range: (u32, u32), args: &[OscType]) -> Vec<Delta>`,
  each returning per-track deltas at `/live/track/get/{name,mute,solo}` and
  `/live/track/get/{volume,panning}` with `[index, value]` args.

- [ ] **Step 1: Write the failing decode tests**

Cover, at minimum: a two-track `track_data` reply decoding to six deltas with correct
indices offset by `range.0`; a `mixer_data` reply decoding to volume and panning per
track; a reply whose length is NOT a whole multiple of the stride returning no deltas
rather than panicking or emitting garbage (a truncated or mismatched reply must fail
closed); and an empty reply returning an empty vec.

- [ ] **Step 2: Run them, confirm they fail**

Run: `cd src-tauri && cargo test bulk`

- [ ] **Step 3: Implement `bulk.rs`**

Pure functions, no I/O. Reject any reply whose length is not `stride * (max - min)`
and return an empty vec — a wrong-length reply means the range attribution is wrong,
and emitting partial data under wrong indices is the exact class of plausible-wrong-data
this codebase exists to avoid. Log the mismatch.

- [ ] **Step 4: Record in-flight ranges and decode on receipt**

Extend the existing shared counts state with `inflight_track_data: Option<(u32, u32)>`
and `inflight_mixer_data: Option<(u32, u32)>`. Set when the poll loop sends a chunk;
read and clear in the receive loop when the matching reply arrives; feed the decoded
deltas through the same `Coalescer` and retained-snapshot map as any other observation,
so they reach the UI and survive a reload identically.

Single-flight serializes keyless requests per address, so at most one range is
outstanding per address at a time. Clear the in-flight range on `expire` too, or a lost
reply strands it.

- [ ] **Step 5: Extend the TypeScript model**

`TrackState` gains `mute: boolean | null`, `solo: boolean | null`, `panning: number | null`.
`applyDelta` handles the three new addresses. Add tests. Keep the existing null-tolerance —
a `null` arg must stay `null`, not become `false` or `0`.

- [ ] **Step 6: Render the columns**

`SetView` shows index, name, volume, and mute/solo state. Keep it plain.

- [ ] **Step 7: Verify and commit**

`cargo test`, `npm test`, `npm run build`, `cargo clippy`. Then relaunch against real
Live and confirm track rows populate — that step is PENDING-USER.

```bash
git add -A && git commit -m "feat: decode bulk track and mixer replies into per-track deltas"
```
