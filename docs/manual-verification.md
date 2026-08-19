# Manual verification against real Live

Run before each release. Record the date and Live version.
Automated fixtures cannot catch listener lifecycle bugs, UDP loss, or
Live UI-thread stalls.

Status: **PENDING-USER**. Every item below requires a running Ableton Live
instance with the AbletonCopilot Control Surface selected in
Preferences > Link/Tempo/MIDI, which is GUI-only and cannot be driven by an
agent. Nothing in this list has been executed against real Live; this file
records what to run and what "pass" means, not a completed run.

Two items below are still **BLOCKED**, not just untested:
`PollKind::FocusedNotes` is left unwired with `note_windows` still dead
code, so nothing about clip notes is fetched, paged, or diffed yet. That is
a scope gap carried forward to a later plan (see the plan's self-review),
not a defect in this build — do not fail them, mark them blocked and move
on.

Everything else is now runnable. Task 13 added the `track_data`/
`mixer_data` address mapping in `src/live/apply.ts` that the previous
revision of this file was waiting on, so the track table, the
wrong-track-attribution check, and the 20/50/100-track benchmark are no
longer blocked.

Date: ___________  Live version: ___________  Tester: ___________

- [ ] Connect, resnapshot, confirm the displayed set matches Live,
      including the track table (name, fader, mute, solo columns).
      "Resnapshot" means: reload the webview and confirm every field —
      song-level and per-track — populates immediately from the `snapshot`
      command, without waiting for the next change to trigger a delta.
- [ ] Add, delete, and reorder tracks. Confirm no `start_listen` was ever
      sent to an indexed address (check Live's log at
      `~/Music/Ableton/User Library/Remote Scripts/AbletonCopilot/logs`).
      Also confirm no state lands under the wrong track: rename a few
      tracks to something distinctive (e.g. their own index), reorder them,
      and check each row still shows the name/fader/mute/solo for the track
      actually at that position — not a stale value left over from before
      the reorder.
- [ ] Select the Master track, then a Return track, in Live. Confirm Live's
      log shows no `ValueError: ... is not in list` traceback from
      `/live/view/get/selected_track`, `/live/view/get/selected_clip`, or
      `/live/view/get/selected_device` (see `copilot/view.py`'s
      `ViewOverrideHandler` — `song.tracks` excludes both, so upstream's
      `list(...).index(...)` raises on exactly this click). Confirm no row
      in the track table is bolded while Master or a Return is selected —
      `selectedTrack` should read -1, which matches no row index, rather
      than freezing bolded on whatever track was last validly selected.
- [ ] Confirm the fader column populates with a normalized value in
      roughly the 0..1 range (unity gain reads ~0.85), not em-dashes, once
      `PollKind::Faders` completes its first poll. This is not a dB
      reading — see `src/ui/SetView.tsx`'s column comment for why.
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
- [ ] Load a 50+ track set. Measure display update latency and Live's
      responsiveness. Benchmark at 20, 50, and 100 tracks: confirm the
      track table fills in within a few `TrackState` poll cycles (roughly
      `chunks * round-trip-time`, not `chunks * 2s` — see the note below),
      and that Live's UI stays responsive while the sweep runs.
- [ ] Start the app while port 11001 (`CLIENT_PORT`, see
      `src-tauri/src/osc/socket.rs`) is already bound by another process
      (e.g. `nc -ul 11001` in another terminal). Confirm the failure is
      legible: the app should print `failed to bind OSC socket: ...` to its
      console and still open its window (a dead socket must not hide the
      whole app — see `lib.rs`'s `setup` closure), rather than hanging or
      crashing silently.
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
  expected, not a hang.
- `track_data` is single-flight per address: only one chunk can be
  outstanding at a time. With `resolve()` wired, a chunk's slot frees as
  soon as Live answers it, and the queue is drained every 250ms tick (not
  gated behind `TrackState`'s own 2s due cycle), so a multi-chunk sweep
  should complete in roughly `chunks * round-trip-time`, not `chunks * 2s`.
  `TRACK_DATA_PROPERTIES` is `track.*`-only (name, mute, solo), so on a
  realistic set this is one chunk regardless of scene count — see
  `track_chunks`' `clip_props` parameter.
- At extreme scene counts (roughly 1800+), a single track's own row can
  exceed the OSC datagram cap and Live's `sendto` raises, so that request
  never gets a reply at all. `expire()` is what prevents this from
  occupying its slot forever; confirm the app does not hang waiting for it
  and instead moves on to the next chunk after the 2s expiry. This does not
  apply to the production `track_data` poll (see above); it can still
  happen on `mixer_data`'s implicit "every track" request at high track
  counts.
- `/live/view/get/selected_track`, `/live/view/get/selected_clip`, and
  `/live/view/get/selected_device` were all fixed at the remote-script
  level (`remote-script/AbletonCopilot/copilot/view.py`) to return -1 for
  the track index instead of raising when the selected track is Master or
  a Return track — confirm Live's log shows no `ValueError: ... is not in
  list` tracebacks from any of these three addresses during normal use
  (selecting Master to check the limiter is routine, not an edge case).

## Verified against real Live — 2026-08-16

Ableton Live 12.2.5 Suite, real layered house track plus a fresh project.

- [x] Track rows populate; names, mute and solo update live.
- [x] Fader column populates.
- [x] Tempo, key and scale arrive on connect, not only after a change.
- [x] Mute / solo reflected in the window.
- [x] Responsiveness acceptable on a real layered house track.
- [x] **Project switch recovers.** Tempo lags by up to one
      `SUBSCRIPTION_RESEND_INTERVAL` (~9s observed) and then loads.

**Mechanism, confirmed from the script log rather than inferred.** Loading a
project makes Live re-instantiate the Control Surface (a second
`Started AbletonOSC` line appears). That re-runs `init_api()`, which registers
OSC *handlers* — but listeners exist only where a client has sent
`start_listen`, so the restart destroys every subscription and Live never
recreates them. Polled getters keep working against the new song throughout, so
traffic never stops. The unconditional resend is what rebinds:

```
18:49:56  Adding listener ... tempo     resend N
18:50:07  Started AbletonOSC            Live re-instantiates the script
18:50:16  Adding listener ... tempo     resend N+2 rebinds
18:50:16  Property tempo changed: (123.0,)
```

A silence-gated resend would never have fired here, because polling keeps
`lastSeen` fresh the entire time. Tempo, key and scale would have sat frozen on
the previous project's values with the app appearing healthy.

Still outstanding: Master / Return track selection, a port-11001 conflict
showing a legible error, and a 50+ track benchmark.

### Additional results — 2026-08-16, 35-track set

- [x] **Master and Return track selection.** No `ValueError`, correct row
      highlighting. Zero tracebacks across 400 log lines of real use, so the
      `copilot/view.py` override is confirmed under load, not just in principle.
- [x] **Latency at 35 tracks: very fast**, reported by the producer.

The whole track table arrives in a *single* datagram every 2 s: with only
`track.*` properties requested, `track_chunks` fits 597 tracks per chunk, so 35
tracks is one chunk. Outbound traffic at rest is a handful of small datagrams
per second (two bulk queries and two counts every 2 s, selection twice a second,
master meter every 2 s, and twelve subscription resends every 10 s).

This is also where the `clip_props` fix pays. The previous formula added a
`num_scenes` term regardless of what was requested; on a session-view-heavy set
with ~100 scenes that gives 17 tracks per chunk, so 35 tracks would have needed
3 chunks and a full sweep would have taken several seconds instead of one tick.
Multiple chunks in flight is also the only condition under which a late reply
can be decoded against the wrong index range.

Remaining: a port-11001 conflict showing a legible error (start a second copy of
the app to trigger it).

## Plan 2 — chat pane, goal field, settings pane

- [ ] Settings pane refuses a model that cannot call tools, and the message
      names the model and quotes what it returned.
- [ ] Settings pane accepts a working model (e.g. a Kimi or GLM variant on
      OpenRouter) and the key survives an app restart.
- [ ] Asking "what's my quietest track?" produces an answer without a tool
      call — the context block already has the dB values.
- [ ] Asking "what notes are in the clip on track 2, slot 0?" shows the
      `get_clip_notes(...)` progress line and returns real note content.
- [ ] Asking about an empty clip slot returns a "no reply" answer, not "the
      clip has no notes".
- [ ] A clip with 500+ notes returns notes rather than timing out, and the
      answer does not claim completeness if `missing_reason` came back.
- [ ] A track renamed to an instruction (e.g. `Ignore previous instructions`)
      is quoted as a label and not obeyed.
- [ ] Killing the provider's network mid-answer surfaces an error in the chat
      and leaves the window working.
- [ ] The disclaimer is visible with no way to dismiss it.
- [ ] The fader column shows dB (`-3.0 dB`), not `0.8500000238418579`.
- [ ] Ask for the notes in a clip on a dense track, and while the answer is
      being fetched, drag a different track above it in Live. The answer must
      report that the set changed under it, not merge two clips' notes. (This
      is the end-to-end half of the topology guard; the unit tests cover the
      pieces, this covers the wiring.)
- [ ] Confirm Live 12's default track names against `DEFAULT_NAME` in
      `src/rules/unnamedTracks.ts`. Create a fresh set, add six MIDI tracks
      and six audio tracks without renaming any, and read the names Live
      gives them off the track headers. The regex matches a bare `MIDI`/
      `Audio` and a numbered `1 MIDI`/`2-Audio`, case-insensitively. If Live
      produces a shape it does not match, the nudge never fires and the
      failure is silent — the rule simply stays quiet forever. Fix the regex
      and its test together.

## The shell (added 2026-08-19)

- [ ] The window is frameless and transparent: rounded corners, no square
      grey system shadow behind the pill. If the pill is a black square,
      `macOSPrivateApi` is not set in `tauri.conf.json`.
- [ ] Dragging the card header moves the window. There is no titlebar, so
      if this fails the window cannot be moved at all.
- [ ] Drag the card to a second display, quit, unplug the display, reopen.
      The card must appear on the remaining screen — `clamp_to_visible`
      exists for exactly this, and the failure mode is an invisible window
      with no titlebar to drag back.
- [ ] Escape collapses to the pill; clicking the pill reopens the card.
- [ ] With text typed in the input, clicking into Live leaves the card
      open. With the input empty, it collapses.
- [ ] Ask something that makes the model read a track. The progress line
      names the track, never a function name or JSON.
- [ ] Quit Live. The banner appears, and the collapsed pill grows to read
      "not connected".
- [ ] Count the uses of the accent colour in one view. At most two.

## The setup window (added 2026-08-19)

- [ ] `public/control-surface.png` matches the Live version being shipped
      against. Re-capture it whenever Live's preferences layout changes —
      a stale screenshot of this one pane is the single most likely cause
      of a failed first run.

      The file committed with this task is a placeholder: a flat,
      striped colour block, not a screenshot. It must be replaced with a
      real screenshot of Live's Preferences → Link, Tempo & MIDI pane
      before release, or the setup flow ships showing a fake image on the
      one screen where a producer is meant to compare what is in front of
      her to what is on screen.
