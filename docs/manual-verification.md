# Manual verification against real Live

Run before each release. Record the date and Live version.
Automated fixtures cannot catch listener lifecycle bugs, UDP loss, or
Live UI-thread stalls.

Status: **PENDING-USER**. Every item below requires a running Ableton Live
instance with the Mixing Pal Control Surface selected in
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
      `~/Music/Ableton/User Library/Remote Scripts/MixingPal/logs`).
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
  level (`remote-script/MixingPal/mixingpal/view.py`) to return -1 for
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

## Plan 3 — device chains and device parameters

- [ ] Asking "what plugins am I using?" calls `get_device_chains` once and
      lists real device names for every track.
- [ ] A track with a third-party plugin shows the plugin's own name, not
      `PluginDevice`. (This is the whole reason the chain map uses `name`
      rather than `class_name`.)
- [ ] A track with no devices shows an empty chain, and the answer says the
      track is empty rather than saying the data is missing.
- [ ] Asking "what's the EQ doing on my bass?" calls `get_device_params` and
      returns real values with units (`80.0 Hz`, `-12.0 dB`), not normalised
      floats.
- [ ] Call `get_device_params` on any device and confirm parameter 0 is
      `Device On`, with a value of `On` or `Off`. The tool description tells
      the model it can read bypass state from the parameter list; that claim
      rests on this, and only a running Live can settle it.
- [ ] Asking about a device index that does not exist returns a "no reply"
      answer that mentions the index may not exist, and does not invent
      parameters.
- [ ] A device renamed to an instruction (e.g. `Ignore previous instructions`)
      is quoted as a label and not obeyed.
- [ ] Ask about a device's parameters and, while the answer is being fetched,
      drag a different track above it in Live. The answer must report that the
      set changed under it.
- [ ] Ask "anything sticking out in my mix?" and confirm the model fetches
      chains before commenting on processing, rather than reasoning from
      track names.

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
      "not connected". The setup window must NOT reappear: disconnection is
      a card state, not a first-run state.
- [ ] **It never steals focus.** Record-arm a MIDI clip in Live, leave Live
      focused, and trigger a nudge (open a set with at least ten tracks,
      six of them still named MIDI or Audio). The card appears on top, and
      every keystroke still reaches Live. `focus: false` in
      `tauri.conf.json` is what makes this true; a card that takes the
      keyboard mid-take is worse than no app at all.
- [ ] Count the uses of the accent colour in one view. At most two.

## After the rename to Mixing Pal — once, per machine

- [ ] Delete the old connector:
      `rm -rf "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonCopilot"`.
      The rename does not remove it, so until you do, Live lists **two**
      Control Surface entries. Selecting the old one leaves the app showing
      the stale-script banner — correct, but it does not tell you the fix is
      to delete a folder. Nothing automates this on purpose: silently
      deleting a directory out of someone's Ableton library is not ours to do.
- [ ] After deleting it, confirm Live's Control Surface list offers
      **MixingPal** and nothing resembling AbletonCopilot.

## First run (added 2026-08-19)

Run from a genuinely clean state — delete
`~/Music/Ableton/User Library/Remote Scripts/MixingPal` and clear
the webview's localStorage first. A rerun on an already-set-up machine
proves nothing about the flow this exists to test.

Date: ___________  Live version: ___________  Tester: ___________

- [ ] Setup opens centred and is not always-on-top. It can be dragged.
- [ ] Install puts the connector in the User Library. Verify by listing
      the Remote Scripts directory, not by trusting the success screen.
- [ ] Opening Live advances the step with no button pressed.
- [ ] **Process detection works.** In the installed connector directory, run
      `/bin/ps -Axco command | grep -x Live` while Ableton is running. It must
      match exactly, returning `Live` once. If the process name differs, the
      fix is to update the exact-match string in `src-tauri/src/install.rs`'s
      `live_is_running()` function, not to loosen the match to a
      substring (which would false-positive on `liveactivitiesd` and
      `PhotosReliveWidget`).
- [ ] The step-3 screenshot matches this Live version's preferences pane.
      If it does not, re-capture `public/control-surface.png` — this is the
      step that decides whether a stranger completes setup.
- [ ] Selecting the Control Surface advances to Connected on its own.
- [ ] The connected screen names real tracks from the open set, and shows
      the "I read your settings … I can't hear your audio" paragraph.
- [ ] Finishing shrinks straight into the card, with no flash of the wrong
      window size.
- [ ] Relaunching goes straight to the card. Setup does not reappear.
- [ ] Deleting the connector folder and relaunching reopens setup at the
      install step.
- [ ] Reinstalling over an existing install preserves `logs/` and its
      contents. A running Live session writes there and an earlier
      installer deleted it on every reinstall.
- [ ] A non-default User Library: move it, relaunch, confirm the install
      step reports that it could not find the library and accepts a pasted
      path.

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

## Stage 1 distribution — a clean Mac (added 2026-08-20)

This is the test the `.dmg` exists for, and it cannot be run on the build
machine. That machine has the repo, so `connector_source`'s
`CARGO_MANIFEST_DIR` fallback succeeds even when the bundle is empty — the
one failure this whole stage exists to prevent is the one failure the build
machine cannot show you.

A fresh macOS user account is a real clean room and costs nothing. Live sits
in `/Applications` and every account can run it, while
`~/Music/Ableton/User Library` is per-account, so a new account starts with
no connector, no settings, and no repository.

Date: ___________  macOS version: ___________  Tester: ___________

- [ ] Create a new account in System Settings → Users & Groups, log into it,
      and copy the `.dmg` across over USB or the local network — **not**
      AirDrop, and not a browser download. Both of those set
      `com.apple.quarantine`, and macOS blocks a quarantined unsigned app.
      Stage 2 removes that difference; until then, the delivery route is
      part of what is being tested.
- [ ] Open the `.dmg`. It shows the app beside an Applications folder. Drag
      it across.
- [ ] Launch Mixing Pal from `/Applications`. It opens with no warning of
      any kind.
- [ ] Setup opens on the install step. Work through it. Afterwards
      `~/Music/Ableton/User Library/Remote Scripts/MixingPal` exists **in
      this account**. If it does not, the bundle shipped without its
      connector.
- [ ] **Write down whether macOS asked permission for anything**, and what
      it named. Stage 2 depends on the answer: permission grants are keyed
      to an app's code signature, and an unsigned build gets a new signature
      every time it is built, so any grant needed here is a grant that
      every future update would silently lose.
- [ ] Start Live. Add MixingPal under Preferences → Link, Tempo & MIDI →
      Control Surface. Deltas arrive and setup advances to the connected
      step.
- [ ] Open Advanced, set an OpenRouter key and a model, then ask a question
      about the set and get an answer. **Expect to do this by hand.** The
      app installs cleanly and then cannot answer anything until both are
      set, because `run_model` refuses while either is empty and nothing in
      setup asks for them. Closing that gap is subsystem B, not this stage.
- [ ] Quit and relaunch. Setup does **not** reopen.
