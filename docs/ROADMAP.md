# Roadmap

Date: 2026-10-22

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

The launch track opened. The proxy, signing and updates are live, and invited
producers run the pilot on them.

## Where we are

App 0.2.11, wire version 15. Shipped:

- The set mirror over OSC, a vendored AbletonOSC fork, and a connector the app
  installs itself.
- Chat with ten read tools: track detail, clips, clip notes, arrangement,
  arrangement notes, device chains, device params, rack contents, mixer, and
  sample.
- The product shell: pill and card, first run, the goal in its own labelled
  row, the connection named beside its dot, a card that drags from anywhere,
  one nudge rule (unnamed tracks), the thread view, starter questions built
  from the open set, the move check-in, the recap on return, and problem
  reports.
- A signed and notarized `.dmg` from tagged release CI, with in-app updates on
  a pilot and a stable channel.
- Prompt guardrails, the honesty evals (`src-tauri/tests/evals.rs`), and the
  craft evals (`src-tauri/tests/craft.rs`), judged by Opus 5.5 against a saved
  calibration.
- The arrangement view: section names in the context block, the arrangement
  map with end times, per-placement mute and MIDI type, bar numbers,
  arrangement notes, loop regions and source lengths, and Live's note names.
- Rack contents with a Drum Rack pad's sample name and nested racks marked.

Model access today: invited producers sign in with an email code, and the
proxy pays for the model from a $5 allowance. Apps from 0.2.11 get GPT-6 Luna;
older apps get Kimi K2.6. The direct OpenRouter path with a pasted key is a
development feature only.

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

   Repaired the craft evaluation on 2026-09-11 after scenarios one to four
   ran red on MiniMax M3 and Kimi K2: the fake Live now preserves audio clip
   type, mentors match the fixture's notes and beat/bar units, and the gates
   allow an argued pad decision and one intervention with its implementation
   details. The judge receives tool arguments/results and scores attribution
   separately from evidence support; invalid judge replies stop majority
   scoring instead of failing answers. Reports retain raw answers, count
   mechanical note defects without gating on them, and name the judge,
   finish reason and available reasoning usage. Use
   `MIXINGPAL_JUDGE_MODEL=anthropic/claude-sonnet-4.6`; the earlier Sonnet 5
   run exhausted the 4000-token cap twice with empty content. The craft
   prompt and parked scenario five are unchanged. Local checks pass. Paid
   reruns returned MiniMax: pad and next-action green, drop red, mix invalid;
   Kimi: mix, next-action and drop red, pad invalid. Both invalid judge
   replies put prose before complete JSON; the parser now accepts one closed,
   validated JSON fence with surrounding prose. All four scenarios now gate
   their automated majority on trust checks and successful required reads,
   with answer shape scored separately. A judge-only replay of nine saved
   answers and two hand-authored controls agreed with 39 of 48 frozen labels.
   Leave-alone and one-intervention labels agreed throughout this sample.
   Evidence support, ear-only restraint, conditional moves, listening tests
   and section purpose still disagreed; reports require human review of those
   properties and mark automated scores provisional. The judge both missed
   wrong beat/bar units and rejected a grounded arrangement trial. The section
   purpose control also leaves room for disagreement about how explicit the
   purpose must be. This is a regression screen with known limits, not a
   release verdict. The fixed sample and explicit judge-only replay live in
   `shared/craft-calibration.json` and `tests/craft.rs`. All 380 application
   tests and 13 local craft checks pass; all eval targets compile. Keep the
   prompt and model fixed while collecting outcomes from real production
   sessions, where the producer can say whether the suggestions helped.

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

8. **Experience level and readable answers.** Built 2026-10-01; the paid
   evals have not run yet. Setup's last step asks "How do you work in
   Live?": New to Live, I finish tracks, or I mix for other people. Settings
   can change the answer. The answer is stored in `preferences.json`, and
   it adds a short section to the system prompt. "I finish tracks" adds
   nothing, so a producer who never chose gets the same prompt as before.
   The level changes the words, not the advice. Every level also got
   shorter answers: short sentences, plain words, the move in bold, and
   about 120 words. The answer text is set in Atkinson Hyperlegible at
   17px, with more line and paragraph spacing. A dyslexic producer picked
   it from four versions of the same answer. The font ships with the app,
   and the rest of the card keeps the system font. Craft scenario six asks
   scenario one's question at New to Live. `MIXINGPAL_EVAL_EXPERIENCE` runs
   the honesty evals at a chosen level. On Luna on 2026-10-22, the drop
   question held trust on 1 of 3 runs, and 0 of 3 at New to Live; the
   other three craft questions passed. Next: find out why the drop answer
   fails, and run the honesty evals at `new_to_live`.

9. **Read aloud.** A button on each answer reads it out with a macOS
   voice, through the webview's speech API. For a dyslexic producer,
   listening beats any font, and producers already work by ear. It reads
   the answer, not the note block.

10. **Answer summary line.** Each answer opens with a one-line takeaway:
    the move, or "leave it". A producer who reads only that line still gets
    the point. This is a prompt change, so it needs a craft property and a
    run of the craft evals before it ships.

11. **Recap on return.** Built 2026-10-08. When she reopens a set after a
    break of 3 hours or more, the card opens on a "Last time" recap: her
    last question, the newest three rated moves with what she heard, and the
    newest two decided notes. The earlier answers fold behind "Show N
    earlier answers". It is built from the saved thread, outcome log and
    notes, so it costs no model call. The check-in from #66 keeps asking
    about the newest move, and the recap never repeats it. × hides the recap
    until the next break.

12. **Kimi K2.6 as the default.** Built 2026-10-03. A pilot trace showed
    MiniMax M3 claiming reads it never made, misreading a set built from
    one-shot clips, and offering reads instead of making them. Routed the
    way the proxy routes, the honesty evals passed 58 of 60 runs for K2.6
    with low reasoning and 44 of 60 for M3. The proxy now serves K2.6 on six
    zero-retention int4, fp8 and bf16 hosts with a 12,000-token output cap,
    because reasoning spends from the same cap as the answer. A typical turn
    takes about 20 seconds and costs about $0.03 to $0.08, so the $5
    allowance buys fewer turns. While the model thinks, the card turns
    through plain verbs. The direct provider path keeps M3, because it
    cannot set the reasoning effort or the cap. Next: the craft suite on
    K2.6.

    Superseded 2026-10-22: the proxy serves GPT-6 Luna to app 0.2.11 and
    later, and K2.6 to older apps. With the Opus 5.5 craft judge, K2.6
    passed 0 to 2 of 15 craft runs: it states ear-only claims as fact,
    such as "the low end is empty", even with that exact example forbidden
    in the prompt. Luna passed 9 of 15 craft runs and 50 of 54 honesty runs,
    with a median turn near 6 seconds, at about a sixth of K2.6's price.
    Luna sends every tool argument, so it needs the nullable optional
    arguments that 0.2.11 brings (#75). Only Azure serves it with zero
    retention.

13. **What the model can see.** Built 2026-10-03. A pilot answer read an
    automated Overdrive switch as Off and invented the automation. Parameter
    reads now mark an automated value as the value at the playhead. Device
    chains say what each device is, give Live's own name when the producer
    renamed it, and mark a device that is off. `get_mixer` reads sends,
    output routing, groups, return tracks and the master. The note tools
    name any MIDI effect, such as Scale, that changes the notes before the
    instrument. The context block gains a FOCUS line: the loop brace, the
    selected device and the selected Session slot. Wire version 14. Next: a
    Compressor's sidechain source, after a spike on Live 12.

14. **Audio clip settings.** Done 2026-10-21 (#73) as `get_sample`. It reads
    the sample behind an audio clip or a Simpler: the file name, never its
    path, length, sample rate, warp mode, gain, transpose, detune, and the
    region that plays. A Simpler adds its mode and slice count. Clip markers
    are not read; the region covers what they were for.

15. **Automation lanes.** A `get_automation` tool that returns breakpoints.
    Clip envelopes come through Live's API. Arrangement automation probably
    needs the saved `.als`, which only reflects the last save, so the result
    must carry the save time and say that unsaved edits are not visible.
    Spike both on Live 12 first. A dense, drawn lane is capped and summarised.

16. **Outcome history.** Ratings under answers write a per-set outcome log
    that outlives the 30-day transcript prune, and the context block shows
    the newest six. Next: a `get_history` tool that searches the log and the
    transcripts younger than 30 days by keyword (track names, frequencies),
    automatic injection of past outcomes for the track in focus, and a list
    of outcomes in the Notes panel where she can remove one.

17. **No lockout from the token flow.** Built 2026-10-06. Model calls stream
    from OpenRouter, and the proxy saves the generation id from the response
    header. Each request has a deadline and a lease, so a dead call stops
    blocking anyone when its lease ends. A call that ends without a known cost
    is paid by Mixing Pal and never charged to the member; reconciliation
    finalizes it from OpenRouter's record. A new question is admitted past an
    earlier call that went wrong; only access, allowance, a paused service or
    five live calls can refuse it.

18. **First questions that reach the aha.** Done 2026-10-07 (#65). The
    empty card builds its three starter questions from the open set: a
    section from its locators, the chain on the selected or first named
    track, and how to turn the loop into a full track. None of them asks
    for a sound judgement. Three eval scenarios cover these questions.
    Next: measure the first click and the first kept move once usage events
    exist.

## When the waitlist says go

All specced or named already. The order is fixed by the gate.

1. **Model access.** Free invited pilot implemented: email-code accounts,
   single-use invitations, a server-owned Kimi K2.6 route, and atomic usage
   reservations against a $5 account allowance for 30 days and a $50 pilot
   ceiling. Public builds use the proxy; the direct provider path requires
   an explicit development feature. Quality sharing starts off, retains
   opted-in turns for 30 days, and permits no training. Operator commands
   cover access, reconciliation, live review exports and deletion, including
   a separate deletion journal for database restores. Activation still needs
   separate staging/production resources, secrets, verified email delivery,
   provider data-policy and credit-cap checks, and a live staging smoke and
   rollback check. Workers Paid is required; hosting charges are separate
   from model allowances. The deployment starts with inference disabled.
   Live in production; item 12 records the model it serves.

   Split telemetry ownership at this boundary. The app records what the
   producer explicitly says she tried, heard, kept or undid. The proxy links
   consented questions, relevant set context, tool arguments/results, raw
   answers, versions, costs, timings and errors under a turn ID. The eval
   harness replays reviewed examples against a held-out set. Keep producer
   reports separate from model-written NOTES, collection consent separate
   from training consent, and retention/deletion part of the design. Review
   labels and corrected answers before any training. This evidence should
   decide whether to change the prompt, tools or model, or evaluate
   post-training. Subscriptions follow measured pilot usage and use the same
   account access checks; price and paid allowances remain undecided.

   In-app problem reports go to hello@mixingpal.com, with the verified account
   email as Reply-To. Answers, failed questions and Settings each offer a report
   form; diagnostics require a separate, unchecked consent for that incident
   and never permit training or enable ongoing sharing. The app keeps up to
   20 pending reports for seven days and shows delivery receipts in Settings.
   The proxy admits five new reports per account per day, stores content
   privately for 30 days after acceptance, and supports account, turn and
   report deletion. Deletion requests keep retrying without retaining report
   content. A separate Worker recovery setting pauses report mail and private reads across database
   restoration and deletion replay. Support emails already sent cannot be
   recalled. Rollout requires the additive reports migration and R2 lifecycle rule, then proxy
   deployment before desktop, with an authorized staging mail/deletion check.

2. **Signing.** Done. Release CI signs with Developer ID, notarizes and
   staples. Every release from v0.2.4 (2026-09-27) is signed.
3. **Updates.** Tagged release CI, hosted artifacts, and automatic update
   checks with separate pilot and stable channels. Test releases in the pilot
   before wider rollout, with an operator control to pause rollout. Require
   Apple signing and notarization for macOS releases plus a separate update
   signature the app verifies. Show an in-app notice with release notes and
   an explicit restart action; never force a restart during a Live session.
   Check app/Wire compatibility so an app update cannot silently leave an
   incompatible Wire installed. Inspect the existing Tauri release setup
   and Wire installer before choosing the smallest implementation. Build and
   test the update flow while Apple enrollment is pending; distributing the
   signed macOS release waits on item 2. Distribution stage 3. Size M.

   Implemented the update path on 2026-09-18: private release CI publishes
   signed artifacts to a dedicated R2 bucket, with pilot and stable manifests
   served through the existing proxy. Promotion reuses the tested files;
   pause controls run separately from builds. The app verifies downloads,
   requires an explicit install/restart action, waits for active operations
   and saved threads, and blocks questions until Wire reports a matching
   version. Local checks include an isolated install through Tauri's updater.
   The website download button is prepared behind a disabled build setting.
   Existing installations need one manual install of the first
   updater-enabled build.

   Live since v0.2.4. Releases go to the pilot channel first; stable is
   paused.
4. **Invites.** The operator CLI emails single-use invitations, and the
   pilot runs on them.

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

On 2026-10-03 the pilot asked for exactly that: a way to check frequencies and
sample statistics. Two steps, in order:

1. **Source files.** Analyse the audio file behind a clip: loudness, true
   peak, crest factor, band energies, spectral centroid and onset density,
   computed in the app from the file Live names. Every result says it
   describes the raw file, before clip gain, warping, devices and the fader,
   so it cannot become a claim about the mix. Cache by path, size and save
   time.
2. **A bounce she picks.** Loudness and band balance per section, aligned to
   the locators. It is the only honest route to questions such as "is the low
   end too thin?".

Both read files only Live names or she chooses, keep everything local, and
send no analysed audio through the proxy. Live's own meters stay out of what
the model sees: a coarse meter invites "it is too loud".
