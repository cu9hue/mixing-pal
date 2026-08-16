# Manual verification against real Live

Run before each release. Record the date and Live version.
Automated fixtures cannot catch listener lifecycle bugs, UDP loss, or
Live UI-thread stalls.

Status: **PENDING-USER**. Every item below requires a running Ableton Live
instance with the AbletonCopilot Control Surface selected in
Preferences > Link/Tempo/MIDI, which is GUI-only and cannot be driven by an
agent. Nothing in this list has been executed against real Live; this file
records what to run and what "pass" means, not a completed run.

Date: ___________  Live version: ___________  Tester: ___________

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

## Notes for the tester

- The poll loop fetches `/live/song/get/num_tracks` and
  `/live/song/get/num_scenes` on every `TrackState` tick (every 2s) and
  skips the chunked `track_data` poll until both are known. On a very large
  or very slow-to-load set, expect a short delay (a couple of poll cycles)
  before track rows populate.
- `track_data` is single-flight per address: only one chunk can be
  outstanding at a time, and this build never resolves a request early on
  reply (that wiring is a later plan's job) — each chunk's slot only frees
  up once its 2s entry expires. On a set large enough to need multiple
  chunks, a full track_data pass can take roughly `chunks * 2s`. Watch for
  this specifically when benchmarking the 50+ track case: if track names
  past the first chunk take multiple seconds to appear, that is this known,
  documented behavior, not a hang.
- At extreme scene counts (roughly 1800+), a single track's own row can
  exceed the OSC datagram cap and Live's `sendto` raises, so that request
  never gets a reply at all. This is expected; confirm the app does not
  hang waiting for it (the request should simply expire and get retried).
