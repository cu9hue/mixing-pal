# Craft ontology — Design

Date: 2026-09-02
Status: approved for planning

## Goal

Give the model a frame for what a good track is and what a good answer looks
like, so its advice converges on something instead of listing options.

The system prompt today is one ontology: what the model can see and what it
cannot claim. Every line is about honesty. The three real-model evals check
the same thing. Nothing in the repo says what to look for in a track, what a
section is for, what a useful move is, or when to say "leave it". So the
model answers from generic production knowledge, and the product's promise on
mixingpal.com, "one good move, with the why, about your track", has no target
in the code.

This spec adds a second layer on top of the honesty layer. It does not
replace it.

## Non-goals

- **No audio analysis, no theory engine.** The first spec's non-goals stand.
  The axes below are judged from notes and settings, or handed to the
  producer's ear.
- **No genre facts anywhere in the repo.** Not in the prompt, not in the
  evals. The goal is free text and people will write anything: a genre, an
  artist, a mood, a reference track. The model already knows what a
  Drake-type beat is. The prompt tells it to use that knowledge in a fixed
  way, and the evals check that it did, never whether it was right. Genre
  correctness is the model's responsibility, and the only check on it is her
  ear.
- **No taste learning.** The model does not learn what she likes across sets.
  Per-set memory is the persistence work on the roadmap and is only pointed
  at here.
- **No change to the tools or the wire.** This is prompt, fixtures, and evals.

## What "naive" means today

Ask the current prompt "why does the drop fall flat?" on the eval fixture (dark
garage at 132, Intro at 0, Drop at 64, a pad that plays in the intro and
outro, drums that run throughout) and the expected answer is:

> I can't hear the set, but looking at the arrangement, the Pad plays in the
> Intro and Outro but not at the Drop, and the Drums run throughout. You could
> try adding a new element at the drop, automating a filter on the drums, or
> adding a riser before bar 64. Consider also checking the levels.

Nothing in it is false. That is what makes it naive. Three moves, unranked,
none tied to a reason, one of them filler. It never says what a drop is for in
garage, so it cannot say what this one is missing.

The mentor answer, from the same data:

> The drop is the first place the pad leaves, and nothing arrives in its
> place. So the drop is the thinnest bar of the track, when in garage it
> should be the fullest. One move: bring a bass in at 64 that owns the sub, on
> the root of your pad chords, and keep it out of the intro so the arrival is
> the contrast. Play from 60 and listen for whether bar 64 feels like a
> landing or a gap. Leave the drums alone, they are already doing the right
> thing by running through.

The distance between the two is four properties, and each maps to one part of
the ontology:

| Property | Ontology part |
| --- | --- |
| Says what the section is for in this genre | Genre prior from the goal |
| Diagnoses on one named axis | The axes |
| One move, the why in the axis's terms, what to listen for | The move shape |
| Says what to leave alone | The notion of enough |

## The ontology

Three layers. The first exists.

### Layer 1: what I can know

The current prompt. Tools, freshness, missing reads, fenced data, "you cannot
hear it". Unchanged by this spec.

### Layer 2: the axes

A track is judged on a small fixed set of dimensions. The genre and the goal
decide where on each axis the track should sit. The axes do not change
between genres; the targets do.

Each axis carries a tag. **Readable** means the model can judge it from notes
and settings. **Ear-only** means it cannot, and may only hand the producer
the test.

| Axis | Question it asks | Tag | Read from |
| --- | --- | --- | --- |
| Energy contour | Does energy rise, drop, or hold on purpose across sections? | Readable, coarse | `get_arrangement`: which tracks play in which section |
| Contrast at section boundaries | Does something change when a section changes? | Readable | `get_arrangement`: entries and exits at each locator |
| Density and space | How many things play at once, and in which registers? | Readable | `get_arrangement`, `get_clip_notes`, `get_arrangement_notes`: note counts and pitch ranges |
| Repetition against variation | What repeats, and what breaks the repeat? | Readable | Notes and `loop_region`, clip lengths on the timeline |
| Low-end ownership | Does one element own the sub, and do the rest stay out? | Readable, partial | Notes below a pitch threshold; EQ high-pass settings from `get_device_params`. Timbre is not readable |
| Rhythmic relationship | Which elements lock and which push? | Readable, coarse | Note starts against the grid |
| Harmonic movement | Static, drifting, or moving, and does that match the intent? | Readable | Notes |
| Groove and feel | Does it swing, does it sit? | Ear-only | Nothing |
| Tone, loudness, and masking | How it sounds | Ear-only | Nothing. Layer 1 already forbids claims here |

"Coarse" and "partial" mean the model may make a claim but must say what the
claim rests on. "Pad and drums are the only things in the intro" is a
readable claim. "The intro is boring" is not.

The list is a first cut, agreed as a starting point, to be sharpened as real
answers show which axes the model reaches for and which it never uses.

### Layer 3: the move

What a good answer is. Four rules.

1. **Say what the section is for.** Whatever the goal says, a genre, an
   artist, a mood, state what the section in question is supposed to do in
   that world before diagnosing. This is the genre prior, it is one sentence,
   and its content comes from the model, not from us. If the goal is empty,
   answer from what can be read and say once that a goal would sharpen the
   advice; never refuse to answer for want of one.
2. **One move, biggest gap first.** Rank silently, give one. It names the
   axis it moves and gives the why in that axis's terms. It is reversible and
   takes under a minute in Live. When the question is a choice, the answer
   picks one side, says which way the goal pushed it, and gives one move on
   that side only. (Amended 2026-09-03: three real runs of scenario five
   showed the model heading "keep" and then offering a change, so the judge
   was grading a hedge, not a decision.)
3. **End with what to listen for.** The model cannot hear. She can. Every move
   ends with a test she performs: where to play from and what to notice.
   Ear-only axes are handed over entirely: the model names the question and
   gives no verdict.
4. **Say what is enough.** Name the axes that are fine and say to leave them.
   If nothing is wrong on any readable axis, say so and stop. An answer that
   invents a change to have something to say fails.

Rule 4 is what makes convergence possible. If every answer proposes a change,
there is no convergence, only a to-do list that never shortens. "The low end
is settled" is half of feeling closer. The other half is memory, which is the
per-set notes on the roadmap: a note records the axis, the move, and whether
she heard it work, so the model does not re-suggest last week's move. The
note format is that work's concern. This spec only fixes that a move is
recorded by axis.

## Where it lives

**This document is the source.** The prompt is derived from it. There is no
separate ontology file; a fourth place for the same list is drift waiting to
happen.

**The prompt** gains one section, "What a good answer is", carrying the axes
as a compact list with their tags and the four rules. Target length: under a
third of the current prompt. The prompt rides on every round trip and every
line costs money on every question, so the section states rules and does
not explain them.

**A tripwire test**, in the pattern of `src-tauri/src/model.rs`'s existing
prompt tests, asserts the prompt names every axis in this spec's table. The
axis names are the join. If the table changes and the prompt does not, the
test says so.

**The goal field** is unchanged. It already reaches the context block as
`GOAL`. Rule 1 is what gives it weight. Letting it carry a reference track is
a separate, small change and is not in this spec.

## Evals

### Why prose judging, and why separately

`src-tauri/tests/evals.rs` asserts on which tools were called, never on
prose, because tool calls are stable across runs and wording is not. That is
right for the honesty layer and it stays.

The craft layer cannot be tested that way. Whether an answer names an axis or
says "leave it" is a property of the prose. So the craft evals use a judge:
a second model call that receives the answer, the mentor answer, and the four
properties, and returns which properties the answer has. Judges are less
stable than tool-call assertions, so:

- Craft evals live in their own test file, `src-tauri/tests/craft.rs`, under
  the same `evals` feature and the same environment variables, so they cost
  money only when asked.
- Each scenario passes on a majority of three runs, not on one.
- The judge scores properties, not similarity. An answer that reaches a
  different move by a sound argument on a named axis passes. The mentor
  answer is there to show the judge the bar, not to be matched.

### The craft fixture

The honesty fixture is deliberately broken: a silent Bass, an injection clip,
a rack that never answers. Craft evals need a set that reads fully and has
one clear gap. New file `shared/craft-set.json`, same shape as
`eval-set.json`:

- Goal "dark garage, 2am", 132 BPM, A minor.
- Locators: Intro 0, Drop 64, Break 96, Drop 2 128.
- Pad, MIDI, -6 dB, no devices. Timeline clips 0 to 64 and 96 to 128. Notes:
  Am and F triads alternating every two beats, mid register.
- Drums, MIDI, -3 dB, one Drum Rack with kick, hats, clap chains. One clip
  0 to 160.
- Bass, MIDI, -5 dB, no devices, no clips anywhere. It answers reads; there
  is just nothing there.
- Vox, audio, -8 dB, one Compressor. Timeline clips 64 to 96 and 128 to 160.

The gap: the drop is the only place the pad leaves, and the bass that should
arrive has not been written.

### Scenarios

Each is a question, a mentor answer, and the properties the judge scores.
The mentor answers show the judge the shape of a good answer. The genre
sentences in them ("in garage the drop should be the fullest bar") are
illustrations of rule 1, not facts the repo stands behind. The judge is told
this: it scores whether a section-purpose sentence is present and tied to
the goal, and it does not score whether the sentence is true. An answer that
makes a different claim about what a garage drop is for passes rule 1 as
well as the mentor answer does.

**1. "why does the drop fall flat?"**

Mentor answer: the one in "What naive means today", with the bass line
amended to "the Bass track is empty, so write a bass" since the fixture
shows the track exists with nothing on it.

Judge scores: section purpose stated; diagnosis on contrast at boundaries or
density; one move with the why; a listen-for; drums marked as leave-it.

**2. "what should I do next?"**

Mentor answer:

> The biggest hole is the low end: the Bass track has nothing on it, and at
> 132 in garage the sub is what the drop stands on. Write a bass part for 64
> to 96, root notes following the pad's A and F, and keep it out of the intro.
> Then play 60 to 68 and listen for whether the drop lands. The drums and the
> pad are fine as they are; do not touch them yet.

Judge scores: exactly one move; ranked as biggest gap with a reason; two
things named as enough.

**3. "is the pad too busy?"**

Mentor answer:

> No. Two triads trading every two beats is one idea, held, and for dark
> garage that stillness is the point. It never plays under the vocal either,
> so nothing is fighting it. Leave it. If anything feels crowded later, it
> will be in the drop, and the pad is not there.

Judge scores: reads the notes before answering (a tool-call assertion, as in
`evals.rs`); verdict is leave-it; density judged from a readable fact; no
invented change.

**4. "is the mix okay?"**

Mentor answer:

> From the settings, there is almost no processing to judge: one compressor
> on the vocal and nothing on the pad, drums, or bass. Levels sit in a normal
> spread. Whether it is loud enough or whether anything masks is yours to
> hear; I cannot. The one thing I can see is that the pad has no high-pass,
> so once you write the bass the two will share the low end. That is the
> first mix move, and it waits for the bass. For now there is nothing to fix.

Judge scores: ear-only axes handed over without a verdict; readable
observation named with its source; no invented problem; conditional move
stated as conditional.

**5. Same set, two goals.** Question "the pad chords, keep or change?" asked
twice, once with the goal "dark garage, 2am" and once with "minimal techno,
peak time".

Judge scores, on each answer alone, three properties: the decision is to
keep the chords, the decision is to change the chords, and the answer says
which way the goal pushed that decision. The judge grades the decision the
answer states, not an aside. A move to register, voicing, note length,
level, or placement keeps the chords; a different progression or chord
quality changes them. Keep and not change is one decision, change and not
keep is the other, both or neither is none. A decision counts only when the
run read the pad's notes and the judge found it tied to the goal.

Two tests. The gate runs each arm once at temperature 0. Both decisions
must count and must differ. The arms differ only in the GOAL line, so a
goal-blind model that is deterministic at 0 gives the same decision twice
and fails: the false-pass rate is zero with no majority or unanimity
needed. The report runs each arm three times at the app's own sampling and
asserts only that every answer decides and ties the decision to the goal;
the six decisions are printed and recorded by hand in
`docs/manual-verification.md`. Neither test says which goal wants which
decision: naming that would be a genre fact, and this repo holds none.

Amended 2026-09-03. The first design graded harmonic movement kept or
reduced and required unanimity across three sampled runs per arm. Three real
runs against the release model showed two things: the model's stance on
movement stayed "keep" under both goals while its answer to the question
asked tracked the goal, and its headline flipped between runs under one goal
as often as between goals, because it hedged a keep with an optional change.
A judge on hedged prose measures the hedge. The fix was to make a choice a
choice in the prompt (Layer 3, rule 2), grade the stated decision, and move
the causal claim to a deterministic run. A paired judge that sees both arms
and says whether they differ "because of the goal" was considered and
rejected: it has no model-independent false-pass rate once the judge sees
the genre labels.

### The judge

One prompt, in `craft.rs`, asking for a JSON object of booleans, one per
property, plus a one-line reason each. The judge sees the question, the
context block, the answer under test, the mentor answer, and the property
list. It does not see the tool calls. The judge model is whichever
`MIXINGPAL_EVAL_MODEL` names; a separate `MIXINGPAL_JUDGE_MODEL` overrides
it, because a judge should be at least as strong as the model it grades.

The judge call caps output at 4000 tokens, since a judge that reasons before
it writes spends its budget thinking; an empty reply is reported with the
provider's finish reason. Scenario 5's gate pins `temperature` to 0 on the
model under test through the harness; the app itself sends no temperature,
and every other scenario runs at that default.

## Acceptance

- The prompt has a "What a good answer is" section naming every axis in the
  table with its tag, and the four rules.
- The tripwire test passes and fails when an axis is removed from the prompt.
- `shared/craft-set.json` exists and the fake Live in `craft.rs` serves it in
  full.
- Scenarios 1 to 4 pass on a majority of three runs against the release
  model; scenario 5's gate passes at temperature 0 and its report shows
  six decisions, each tied to its goal. The runs are recorded in
  `docs/manual-verification.md` beside the honesty evals.
- The honesty evals still pass with the new prompt. The craft section must
  not loosen "you cannot hear it".
- Prompt growth is under a third of the current prompt.

## Open questions

1. Which goals should the second fixture use? The waitlist will say.

Settled on 2026-09-02, in review:

- The axes are a first cut and get sharpened as we go.
- No genre facts are baked in. The evals check that the model used the goal,
  not what it concluded from it.
- A judge model is accepted. There is no other way to enforce an ontology
  on prose, and the separation from the tool-call evals is the mitigation.
