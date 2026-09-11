# Roadmap

Date: 2026-09-08

What ships next and why, in one place. This file is the whole of the
project's planning record; the design documents that used to sit beside it
are in git history before 2026-09-08. Update it when a milestone ships.

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

App 0.2.4, wire version 12. Shipped:

- The set mirror over OSC, a vendored AbletonOSC fork, and a connector the app
  installs itself.
- Chat with eight read tools: track detail, clips, clip notes, arrangement,
  arrangement notes, device chains, device params, rack contents.
- The product shell: pill and card, first run, the goal in its own labelled
  row, the connection named beside its dot, a card that drags from anywhere,
  one nudge rule (unnamed tracks), and the thread view.
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

Model access today: the producer pastes an OpenRouter key in Settings and
the app calls `minimax/minimax-m3` unless she names another model. That is
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

3. **Set identity.** Done 2026-09-08. The connector stores an id in the set
   with `Song.set_data` under one key, written only when absent, and
   answers `/live/mixingpal/get/set_identity` with the id, the set's name,
   and its path. `SetState` carries all three; `setId` falls back to the
   path. The spike ran on Live 12.2.5 on 2026-09-08: the write leaves a clean
   set clean, a saved id survives a reopen of a large set, and each set opened
   in one session gets its own. The one exception to the no-write rule; see
   "Not doing".

4. **Per-set persistence.** Done 2026-09-08. Each set's thread is saved
   beside `settings.json`, under `threads/`, looked up by the stored id and
   then by the path so it follows a set whose id was minted again, and
   dropped thirty days after its last open. The card switches threads only
   when the identity has changed to another set and held, never mid-turn;
   a restored thread carries a recap line. A quit mid-turn keeps the
   question and loses the answer.

5. **Per-set notes.** Done 2026-09-08. A list of outcome bullets per set,
   `move`, `heard`, or `decided`, kept in the thread file and shown above the
   thread. The model reads them after the goal and may add or retire at most
   two per answer through a fenced `note` block the app merges
   deterministically: exact de-duplication, a cap of twelve that takes the
   model's bullets before hers, and nothing she has touched is ever retired.
   The note outlives the transcript's 30-day prune. Never a summary and never
   rewritten, on the second brain's evidence that rewriting collapses.

6. **Advice quality.** Shipped
   2026-09-02 (c095d72..ea9bc34): the prompt's "What a good answer is"
   section, a clean fixture, and five judge-scored craft scenarios beside
   the tool-call evals. The value landed with the prompt section: answers
   got crisper by ear. The eval loop is regression cover for when the prompt
   or the model changes, and it ran once, on scenario five, across five paid
   sessions on 2026-09-03 and 2026-09-04. Parked red 2026-09-04. It found no prompt
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

7. **Default model and latency.** Done 2026-09-11. `tests/latency.rs` runs
   one two-tool question five times against the model the environment
   names and asserts a median turn under a minute, a non-empty answer, and
   a rack read that came back whole on every run. Measured through
   OpenRouter on 2026-09-11, Chinese models with reasoning off by default:

   | Model | Median | Slowest | Result |
   | --- | --- | --- | --- |
   | `minimax/minimax-m3` | 4.4 s | 5.8 s | passed, five of five read the rack |
   | `moonshotai/kimi-k2` | 10.9 s | 12.4 s | passed |
   | `deepseek/deepseek-v4-pro` | 13.3 s | 16.7 s | passed |
   | `moonshotai/kimi-k2-0905` | | | one run answered without opening the rack |
   | `qwen/qwen3.6-plus` | | | one run answered without opening the rack |
   | `z-ai/glm-4.6` | | | one empty answer, one run skipped the rack |
   | `deepseek/deepseek-v4-flash` | | | never read the rack, one empty answer |

   `minimax/minimax-m3` is the default when the model field is blank. The
   model timeout stays at 180 s: the default's slowest single round trip
   was 2.6 s, the bound is there for a slower model she types herself, and
   60 s is the bound that cut off a real turn on 2026-09-02. Re-run the
   target when the default changes. Item 6's craft evals are re-opened
   against it next: scenarios one to four first.

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

From the first spec, still standing: no writes to the set's contents, no
screen capture, no music theory engine.

"No writes to the set" was reworded on 2026-09-07 to "no writes to the set's
contents", and one exception was carved out: the identity key that item 3
stores with `Song.set_data`, one key, written only when absent, never
visible in Live.
Nothing the app does changes a note, clip, device, fader, name, or locator.
The exception's conditions: one key, written only when the key is absent on
two consecutive polls, at most one attempt per handler lifetime, read back
before it is reported, never visible in Live. Any further write needs a
design of its own, recorded here.

Audio analysis moved off this list on 2026-09-05. It is not off the table; it
is the expensive layer, and the settings-only version ships first. Build it when
the settings-only advice has a producer using it and the questions she asks are
the ones only a listener can answer. Until then the app says it cannot hear,
because it cannot.
