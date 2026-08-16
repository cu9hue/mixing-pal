# Manual verification against real Live

Run before each release. Record the date and Live version.
Automated fixtures cannot catch listener lifecycle bugs, UDP loss, or
Live UI-thread stalls.

Status: **PENDING-USER**. Every item below requires a running Ableton Live
instance with the AbletonCopilot Control Surface selected in
Preferences > Link/Tempo/MIDI, which is GUI-only and cannot be driven by an
agent. Nothing in this list has been executed against real Live; this file
records what to run and what "pass" means, not a completed run.

Four items below are currently **BLOCKED**, not just untested: the
frontend (`src/live/apply.ts`) has no address mapping for `track_data` or
`mixer_data`, so `state.tracks` stays `{}` and the track table always
renders zero rows no matter what the poll loop sends; and `PollKind::FocusedNotes`
is left unwired with `note_windows` still dead code, so nothing about clip
notes is fetched, paged, or diffed yet. Those are scope gaps carried
forward to a later plan (see the plan's self-review), not defects in this
build — do not fail them, mark them blocked and move on.

Date: ___________  Live version: ___________  Tester: ___________

- [ ] Connect, resnapshot, confirm the displayed set matches Live.
      Song-level fields only (tempo, playing state, scale, root note,
      selected track) — the track table is separately BLOCKED, see below.
      "Resnapshot" now means: reload the webview and confirm the song
      fields populate immediately from the `snapshot` command, without
      waiting for the next change to trigger a delta.
- [ ] Add, delete, and reorder tracks. Confirm no `start_listen` was ever
      sent to an indexed address (check Live's log at
      `~/Music/Ableton/User Library/Remote Scripts/AbletonCopilot/logs`).
      The "confirm no state lands under the wrong track" half of this item
      is BLOCKED (see above — no track fields render at all yet).
- [ ] Change the selected track, clip, and device. Confirm the selected
      *track* follows (the only one of the three the frontend currently
      models — `selectedClip`/`selectedDevice` aren't in `SetState` yet).
      "No phantom note edit is reported" is BLOCKED — see FocusedNotes
      below.
- [ ] BLOCKED (until a later plan wires `PollKind::FocusedNotes` and calls
      `NoteTracker`). Edit notes in the focused MIDI clip. Confirm the diff
      appears.
- [ ] BLOCKED (until a later plan wires `PollKind::FocusedNotes` and calls
      `note_windows` for paging). Open a clip with 500+ notes. Confirm
      paging works rather than timing out, and that a dense clip never
      reports "no answer".
- [ ] BLOCKED (until a later plan parses `track_data` / `mixer_data`
      replies into `SetState`). Load a 50+ track set. Measure display
      update latency and Live's responsiveness. Benchmark at 20, 50, and
      100 tracks.
- [ ] Restart Live mid-session. Confirm the app reconnects: song-level
      fields (tempo, is_playing, scale_name, root_note, selected_track,
      selected_scene) should resume updating within
      `SUBSCRIPTION_RESEND_INTERVAL` (10s) of Live coming back up, even if
      the app was started before Live and its first subscribe attempt went
      into the void.
- [ ] Load a different project in the same running Live instance (not a
      restart). Confirm song-level fields pick up the new project's values
      within 10s rather than freezing at the old project's — this is the
      case a silence-only reconnect check would miss, since polled
      addresses (track_data, mixer_data, meters) keep replying against the
      new project the whole time.
- [ ] Reload the webview. Confirm no orphaned subscriptions survive
      (Live's log must show no duplicate listener registrations), and
      confirm the reloaded webview immediately shows the current song
      fields via the `snapshot` command rather than a blank state until the
      next change.

## Notes for the tester

- **Poll rates.** `RequestTable::resolve` is now wired into the receive
  loop (every inbound packet clears its own single-flight slot as soon as
  the reply arrives), so `TrackState`/`Faders`/`Meters` should poll close
  to their spec'd 2s, `Selection` close to 1s — not the 4s/2.5s/3s the
  previous (unresolved) build actually produced. `expire()` now only
  matters as a backstop for a request that never gets a reply at all (see
  the datagram-overflow note below), not as the primary way a slot frees.
- The poll loop fetches `/live/song/get/num_tracks` and
  `/live/song/get/num_scenes` on every `TrackState` tick and skips the
  chunked `track_data` poll until both are known. Expect a short delay (a
  poll cycle or two) after connecting before the counts populate — this is
  expected, not a hang, and the frontend can't show it yet regardless (see
  the BLOCKED item above).
- `track_data` is single-flight per address: only one chunk can be
  outstanding at a time. With `resolve()` wired, a chunk's slot frees as
  soon as Live answers it, and the queue is drained every 250ms tick (not
  gated behind `TrackState`'s own 2s due cycle), so a multi-chunk sweep
  should complete in roughly `chunks * round-trip-time`, not `chunks * 2s`.
- At extreme scene counts (roughly 1800+), a single track's own row can
  exceed the OSC datagram cap and Live's `sendto` raises, so that request
  never gets a reply at all. `expire()` is what prevents this from
  occupying its slot forever; confirm the app does not hang waiting for it
  and instead moves on to the next chunk after the 2s expiry.
- `/live/view/get/selected_device` was fixed at the remote-script level
  (`remote-script/AbletonCopilot/copilot/view.py`) to return `(track, -1)`
  instead of raising when no device is selected on the selected track —
  confirm Live's log shows no `ValueError: None is not in list` tracebacks
  from this address during normal use (deselecting a device is a normal
  state, not an edge case).
