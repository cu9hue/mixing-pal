# Roadmap

Date: 2026-09-05

What ships next and why, in one place. The specs under `docs/superpowers/specs`
hold the detail. This file is the index. Update it when a spec is approved or a
milestone ships.

## The gate

One decision shapes everything below. The waitlist at
[mixingpal.com](https://mixingpal.com) opened on 2026-09-02 and promotion starts
on 2026-09-03. If sign-ups show demand, the launch track opens. If they do not,
it stays shut and nothing in it gets built.

The launch track has a fixed order. A proxy that holds the provider key comes
before any invite goes out, because an invited producer cannot run the app on a
pasted OpenRouter key. So: proxy, then signing, then invites. Never the reverse.

Everything under **Now** ships with no gate. It needs no proxy, no signing, and
no server.

## Where we are

App 0.2.3, wire version 11. Shipped:

- The set mirror over OSC, a vendored AbletonOSC fork, and a connector the app
  installs itself.
- Chat with eight read tools: track detail, clips, clip notes, arrangement,
  arrangement notes, device chains, device params, rack contents.
- The product shell: pill and card, first run, the goal, one nudge rule
  (unnamed tracks), and the thread view.
- An unsigned `.dmg`, with `docs/opening-an-unsigned-build.md` for getting past
  Gatekeeper.
- Prompt guardrails and six honesty evals (`src-tauri/tests/evals.rs`), plus
  the craft layer: the "What a good answer is" prompt section and five
  judge-scored craft evals (`src-tauri/tests/craft.rs`). The honesty evals
  and craft scenarios one to four have not yet run against a real model.
  Scenario five ran five times on 2026-09-03 and 2026-09-04 and is parked
  red (see item 6).
- The arrangement view: section names in the context block, the arrangement
  map with end times, per-placement mute and MIDI type, bar numbers,
  arrangement notes, loop regions and source lengths, and Live's note names.
- Rack contents with a Drum Rack pad's sample name and nested racks marked.

Model access today: the producer pastes an OpenRouter key in Advanced. That is
fine for one person and a blocker for everyone else.

## The rule for advice

Three parties, three jobs. Settled 2026-09-02 and standing for every item in
the advice vertical.

- **We own what good is.** The axes a track is judged on, the shape of a
  move, and the rule that an answer may say "leave it". This is the opinion,
  and it is the only part that can be defended in a test.
- **The model owns the how.** Which move, in which genre's terms, and why.
  No genre facts live in the repo: every rule of that kind is a workaround
  for a limit the model may not have, and it would constrain a stronger
  model as much as it helps a weaker one.
- **The user owns whether it worked.** The model cannot hear. The outcome
  signal comes back from her ear, so every move ends with what to listen
  for, and the per-set notes exist to record what she heard. Without that
  record there is no outcome to converge on.

One corollary for anything that accumulates: it needs a deletion story from
the start. Context that only grows degrades what it was meant to improve.

## Now

Ordered. Each item says what, why, size, and what it waits on.

1. **Land the arrangement view.** Done 2026-09-02 (ba5c78e).

2. **Thread view.** Done 2026-09-05. Earlier exchanges scroll above the
   current one inside the card; the newest question is scrolled to the top
   of the body on send. The thread is the session and dies with the app
   until item 4.

3. **Set identity.** The connector writes a random id into the set with
   `Song.set_data` on first contact and reads it back with `Song.get_data` on
   every load. The app receives it in the mirror. Why: everything per-set needs
   to know which set is open, and the mirror has no name or path today. A
   fingerprint from track names breaks the moment she adds a track. Size M,
   wire bump. Open question to settle first: what `set_data` does on a set
   that has never been saved.

4. **Per-set persistence.** The raw thread saved in the app data directory,
   keyed by set id, restored on open, dropped 30 days after last open. Why: she
   closes the app and comes back to the track. Size S. Waits on 3.

5. **Per-set notes.** A short note the model writes per set: what was
   discussed, what she decided, what she was going to try. Shown in the card,
   editable, and sent ahead of the question as a user turn on return, the same
   way the context block rides. Why: a note beats a transcript. The live
   context corrects stale facts on every turn, and she can read it. A note
   records outcomes (the axis, the move, what she heard), never advice, and
   carries a size cap, so it does not become a second prompt. Size M.
   Waits on 4.

6. **Advice quality.** Spec:
   `docs/superpowers/specs/2026-09-02-craft-ontology-design.md`. Shipped
   2026-09-02 (c095d72..ea9bc34): the prompt's "What a good answer is"
   section, a clean fixture, and five judge-scored craft scenarios beside
   the tool-call evals. The value landed with the prompt section: answers
   got crisper by ear. The eval loop is regression cover for when the prompt
   or the model changes, and it ran once, on scenario five, across five paid
   sessions on 2026-09-03 and 2026-09-04 (plan
   `docs/superpowers/plans/2026-09-03-goal-gate.md`, record in
   `docs/manual-verification.md`). Parked red 2026-09-04. It found no prompt
   defect. It found three facts about the release model through OpenRouter:
   it can outlast the app's 180-second limit; it is not deterministic at
   temperature 0; and it headlines "keep" over a move that changes the
   chords. It also showed the goal line works: every graded answer tied its
   reasoning to the goal and the move changed with it. What did not change
   was the keep-or-change verdict, which the rule above says is the model's
   to hold. A gate on the verdict is therefore the wrong instrument; a gate
   on whether the move differs would be the right one, and it needs a
   majority design because the model does not hold still at 0. Not building
   that now: nobody on the waitlist feels it. Unpark when the prompt's
   craft section or the default model changes, and run scenarios one to
   four first. Judge with a model that does not reason
   (`MIXINGPAL_JUDGE_MODEL`, checklist has the one used).

7. **Default model and latency.** The same slowness that broke the judge is
   what a producer waits on every turn: the release model through OpenRouter
   took over 180 seconds on some turns and needs three minutes of timeout
   to be safe. Why: this is the only item here a producer feels on every
   question, so it may jump the queue. What it is: measure turn latency per
   candidate model on the eval fixtures, pick a default that answers a
   two-tool question in under a minute, and only then re-open the craft
   evals against it. Size M. Waits on nothing.

## When the waitlist says go

All specced or named already. The order is fixed by the gate.

1. **Model access.** Subsystem B of the product UI spec: a proxy holding the
   provider key, invite codes, per-account caps, consented trace capture. No
   spec yet. Size L.
2. **Signing.** Apple enrollment, Developer ID signing, notarization, stapling.
   Distribution stage 2. Size M, mostly waiting on Apple.
3. **Updates.** Tagged release CI, hosted artifacts, the updater. Distribution
   stage 3. Size M.
4. **Invites.**

## Deferred, with the trigger

| Item | Why it waits | Build it when |
| --- | --- | --- |
| Streaming | A question is two to four round trips; streaming only the last one buys little | Prose after the last tool call routinely runs past a few seconds |
| Stock-device extractor | The drill-down tools removed the blindness it was for (spec amendment 2026-08-19) | Drill-down proves insufficient in practice |
| More nudge rules | Interrupting mid-take is the most intrusive thing the app can do | A second observation is true often and cheap to check |
| Ableton Extensions SDK | Needs the 12.4.5 beta and cannot hold a process | Extensions ship stable with a background mode |
| Local model provider | The `ModelProvider` seam exists; nobody has asked | Someone asks |

## Not doing

From the first spec, still standing: no writes to the set, no audio analysis,
no screen capture, no music theory engine.
