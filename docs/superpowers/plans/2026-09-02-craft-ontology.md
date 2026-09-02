# Craft Ontology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system prompt a craft layer (axes, a genre prior from the goal, the shape of a move, permission to say "leave it") and prove it with judge-scored evals on a clean fixture.

**Architecture:** The prompt in `src-tauri/src/model.rs` gains one section, pinned by tripwire tests. The eval harness in `src-tauri/tests/evals.rs` is split so its fake Live and agent loop live in `src-tauri/tests/common/mod.rs`, shared with a new `src-tauri/tests/craft.rs`. The fake learns to answer device reads from an optional `deviceDetail` key in a fixture, so the new `shared/craft-set.json` reads in full while the honesty fixture keeps its deliberate silences. Craft scenarios ask a real model, then a judge model scores the answer against named properties; a scenario passes on a majority of three runs.

**Tech Stack:** Rust (tokio, reqwest, serde_json, rosc), the `evals` cargo feature, vitest for the fixture pin, an OpenAI-compatible chat endpoint.

**Spec:** `docs/superpowers/specs/2026-09-02-craft-ontology-design.md`

## Global Constraints

- **Start from a clean tree.** The arrangement view diff must be committed first (roadmap item 1). Nothing here touches those files, but a mixed commit is not acceptable.
- **No genre facts anywhere in the repo.** Not in the prompt, not in the evals. The evals check that the model used the goal, never what it concluded from it. Mentor answers illustrate the shape; the judge is told not to grade their truth.
- **No change to the tools or the wire.** Prompt, fixtures, and evals only. `shared/wire-version.json` does not move.
- **Prompt growth is under a third of the current prompt.** Measured 2026-09-02 at 5213 characters. Ceiling: 6950.
- **The craft section must not loosen "you cannot hear it".** Every existing prompt test in `model.rs` keeps passing.
- **Craft evals live in their own test file under the same `evals` feature and the same environment variables** (`MIXINGPAL_EVAL_BASE_URL`, `MIXINGPAL_EVAL_MODEL`, `MIXINGPAL_EVAL_KEY`), plus optional `MIXINGPAL_JUDGE_MODEL`.
- **Plain `cargo test` stays off the network.** Both eval targets are gated on `required-features = ["evals"]`.
- **Each craft scenario passes on a majority of three runs.** The judge scores properties, not similarity.
- **Repo conventions:** run `cargo test` from `src-tauri`; run `npx vitest run` from the repo root; pipe test output to a file under the scratchpad and grep it. Commit messages are one line in the imperative, no prefix, matching `git log`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src-tauri/tests/common/mod.rs` | **Create.** Fixture loading, the mirror, the fake Live, `Turn`, and `ask`. Shared by both eval binaries. |
| `src-tauri/tests/evals.rs` | **Modify.** Keeps only the honesty scenarios and their prose helpers. Calls into `common`. |
| `src-tauri/tests/craft.rs` | **Create.** The judge, the majority runner, the craft scenarios, and a no-network test that the fake serves the craft fixture in full. |
| `src-tauri/Cargo.toml` | **Modify.** Register the `craft` test target behind the `evals` feature. |
| `src-tauri/src/lib.rs` | **Modify.** Re-export `post_chat` from `eval_api` for the judge. |
| `src-tauri/src/model.rs` | **Modify.** The "What a good answer is" section and its tripwire tests. |
| `shared/craft-set.json` | **Create.** The clean fixture. |
| `shared/craft-context.txt` | **Create.** Its rendered context block. |
| `src/digest/evalFixture.test.ts` | **Modify.** Pin both fixtures to their context files. |
| `docs/manual-verification.md` | **Modify.** A "Craft evals" section: how to run, cost, checklist. |

---

### Task 1: Move the eval harness into `tests/common`

**Files:**
- Create: `src-tauri/tests/common/mod.rs`
- Modify: `src-tauri/tests/evals.rs`

**Interfaces:**
- Produces, in `common`:
  - `pub const MAX_ROUND_TRIPS: usize`
  - `pub fn load(name: &str) -> serde_json::Value` reads and parses `shared/<name>`
  - `pub fn context(name: &str) -> String` reads `shared/<name>` with the trailing newline removed
  - `pub fn settings() -> Settings` from the three `MIXINGPAL_EVAL_*` variables
  - `pub fn mirror(f: &Value) -> Arc<Mutex<Coalescer>>`
  - `pub async fn fake_live(f: Value) -> Arc<LiveQuery>`
  - `pub struct Turn { pub answer: String, pub called: Vec<String>, pub truncated: bool }` with `pub fn called_before(&self, first: &str, second: &str) -> bool`
  - `pub async fn ask(f: Value, context: &str, question: &str) -> Turn`

This is a pure move. Behaviour of `evals.rs` does not change, and it cannot be run here (it costs money), so the check is that it compiles and that plain `cargo test` is untouched.

- [ ] **Step 1: Create `src-tauri/tests/common/mod.rs` with this skeleton, then paste the moved bodies**

```rust
//! Shared by `evals.rs` (the honesty scenarios) and `craft.rs` (the craft
//! scenarios): a fixture loader, the mirror, a fake Live that answers from
//! a fixture, and the loop that drives one turn against a real provider.
//!
//! Compiled only under `--features evals`, because both binaries that
//! include it are gated on that feature in `Cargo.toml`.
#![allow(dead_code)] // each binary uses a subset

use mixing_pal_lib::eval_api::*;
use rosc::OscType;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Mirrors `MAX_ROUND_TRIPS` in `src/agent/loop.ts`. The eval drives its own
/// loop -- the shipped one is TypeScript and is covered by `loop.test.ts`
/// against a scripted stub -- so this constant is a copy, and a change to
/// the real one will not reach it.
pub const MAX_ROUND_TRIPS: usize = 6;

/// `shared/<name>`, parsed.
pub fn load(name: &str) -> Value {
    let path = format!("{}/../shared/{name}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path} parses: {e}"))
}

/// `shared/<name>` as a context block, trailing newline removed.
pub fn context(name: &str) -> String {
    let path = format!("{}/../shared/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .trim_end()
        .to_string()
}

pub fn settings() -> Settings {
    // MOVED VERBATIM from evals.rs `fn settings()`.
}

/// The mirror the tools read for track count and per-track identity.
pub fn mirror(f: &Value) -> Arc<Mutex<Coalescer>> {
    // MOVED VERBATIM from evals.rs `fn mirror()`.
}

fn slot_is_filled(track: &Value, slot: Option<i32>) -> bool {
    // MOVED VERBATIM, doc comment included.
}

fn clip_is_midi(track: &Value) -> bool {
    // MOVED VERBATIM, doc comment included.
}

fn arrangement_clip_exists(track: &Value, index: Option<i32>) -> bool {
    // MOVED VERBATIM, doc comment included.
}

pub async fn fake_live(f: Value) -> Arc<LiveQuery> {
    // MOVED VERBATIM, doc comment included. The whole match, every arm.
}

pub struct Turn {
    pub answer: String,
    pub called: Vec<String>,
    /// MOVED VERBATIM: the doc comment on `truncated`.
    pub truncated: bool,
}

impl Turn {
    pub fn called_before(&self, first: &str, second: &str) -> bool {
        // MOVED VERBATIM.
    }
}

/// One turn against the real provider, tools answered by the fake Live.
/// The context block rides ahead of the question as a user turn, exactly
/// as `Conversation.tsx` sends it.
pub async fn ask(f: Value, context: &str, question: &str) -> Turn {
    let ctx = ToolContext {
        coalescer: mirror(&f),
        query: Arc::new(Mutex::new(Some(fake_live(f).await))),
    };
    let s = settings();
    let client = reqwest::Client::new();

    let mut messages = vec![ChatMessage {
        role: "user".into(),
        content: Some(format!("{context}\n\n---\n\n{question}")),
        tool_calls: None,
        tool_call_id: None,
    }];
    let mut called: Vec<String> = Vec::new();

    for _ in 0..MAX_ROUND_TRIPS {
        // MOVED VERBATIM from evals.rs `async fn ask()`: the loop body.
    }
    Turn { answer: String::new(), called, truncated: true }
}
```

The "MOVED VERBATIM" markers name the functions in `src-tauri/tests/evals.rs` whose bodies (and doc comments) move unchanged: `settings` (about line 45), `mirror` (about line 58), `slot_is_filled` (about line 83), `clip_is_midi` (about line 105), `arrangement_clip_exists` (about line 113), `fake_live` (about lines 130 to 388), `Turn` and `impl Turn` (about lines 390 to 408), and the loop body of `ask` (about lines 421 to 451). The only edits: `fixture()` and `context_block()` are replaced by the `load` and `context` functions above, and `ask` takes the fixture and context as parameters instead of calling `fixture()` and `context_block()` itself.

- [ ] **Step 2: Cut the moved items out of `evals.rs` and point it at `common`**

At the top of `src-tauri/tests/evals.rs`, after the crate-level doc comment and before the `use` lines, add:

```rust
mod common;
use common::Turn;
```

Delete the moved functions, `MAX_ROUND_TRIPS`, `Turn`, `impl Turn`, and `ask` from `evals.rs`. Replace `fixture()` and `ask()` with:

```rust
fn fixture() -> Value {
    common::load("eval-set.json")
}

async fn ask(question: &str) -> Turn {
    common::ask(fixture(), &common::context("eval-context.txt"), question).await
}
```

Remove imports `evals.rs` no longer needs (`rosc::OscType`, `Arc`, `Mutex`, and whichever `eval_api` items only the moved code used). Keep `lower`, `strip_fenced`, `strip_ci`, `injected_clip_name`, `names_a_read_gap`, the phrase lists, and every `#[tokio::test]`.

- [ ] **Step 3: Compile both test targets and run the ordinary suite**

```bash
cd src-tauri
cargo test --features evals --test evals --no-run 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t1-evals-build.log | tail -3
cargo test 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t1-cargo-test.log | grep -E 'test result|error' 
```

Expected: the first ends in `Finished` with no warnings about unused items; the second shows every `test result: ok` line and no `error`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/common/mod.rs src-tauri/tests/evals.rs
git commit -m "Move the eval harness into tests/common so a second eval binary can share it"
```

---

### Task 2: The craft fixture and its pinned context block

**Files:**
- Create: `shared/craft-set.json`
- Create: `shared/craft-context.txt`
- Modify: `src/digest/evalFixture.test.ts`

**Interfaces:**
- Produces the fixture schema Task 3's fake reads. Same shape as `shared/eval-set.json` plus, per track, optional `volume` and `panning` numbers and an optional `deviceDetail` object keyed by top-level device index as a string (`"0"`), each entry holding `params` (an array of `[name, value]` string pairs) and, for a rack, `chains` (an array of `{ name, note, devices: [names] }`).

- [ ] **Step 1: Extend the vitest pin to cover a second fixture, and watch it fail**

Replace the whole of `src/digest/evalFixture.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildContext } from "./build";
import { SetState, TrackState } from "../live/model";
import evalFixture from "../../shared/eval-set.json";
import evalContext from "../../shared/eval-context.txt?raw";
import craftFixture from "../../shared/craft-set.json";
import craftContext from "../../shared/craft-context.txt?raw";

// Each fixture is one eval suite's set, and Rust builds its fake Live from
// the same file. Rust cannot call buildContext, so the rendered digest is
// checked in beside it and pinned here -- the same two-language pinning
// shared/wire-version.json already uses.
interface EvalFixture {
  goal: string;
  song: Omit<SetState, "tracks">;
  tracks: Array<{ name: string; mute: boolean; solo: boolean; volumeDb: string }>;
}

function fixtureState(fixture: EvalFixture): SetState {
  const tracks: Record<number, TrackState> = {};
  fixture.tracks.forEach((t, i) => {
    tracks[i] = {
      name: t.name,
      mute: t.mute,
      solo: t.solo,
      volume: null,
      volumeDb: t.volumeDb,
      panning: null,
      meter: null,
    };
  });
  return { ...fixture.song, tracks };
}

describe.each([
  ["eval-set.json", evalFixture, evalContext],
  ["craft-set.json", craftFixture, craftContext],
])("the fixture %s", (_name, fixture, context) => {
  it("renders to the checked-in context block", () => {
    const expected = context.replace(/\n$/, "");
    expect(buildContext(fixtureState(fixture), fixture.goal)).toBe(expected);
  });
});
```

Run: `npx vitest run src/digest/evalFixture.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t2-fail.log | tail -8`

Expected: FAIL, the import of `craft-set.json` cannot be resolved.

- [ ] **Step 2: Write `shared/craft-set.json`**

Track order follows the spec: Pad, Drums, Bass, Vox. The Pad's chords are A minor and F major triads trading every two beats. The drums are a two-bar pattern on the Drum Rack's pads. Bass answers reads and has nothing on it. Every track reads in full: no `silent`, and every device has a `deviceDetail` entry.

```json
{
  "goal": "dark garage, 2am",
  "song": {
    "tempo": 132,
    "isPlaying": false,
    "rootNote": 9,
    "scaleName": "Minor",
    "selectedTrack": 0,
    "scriptVersion": 7,
    "cuePoints": [
      { "name": "Intro", "time": 0 },
      { "name": "Drop", "time": 64 },
      { "name": "Break", "time": 96 },
      { "name": "Drop 2", "time": 128 }
    ],
    "cuePointsTotal": 4
  },
  "tracks": [
    {
      "name": "Pad",
      "volumeDb": "-6.0 dB",
      "volume": 0.72,
      "panning": 0.0,
      "mute": false,
      "solo": false,
      "midi": true,
      "silent": false,
      "clips": [{ "slot": 0, "name": "Chords" }],
      "devices": [],
      "racks": [],
      "deviceDetail": {},
      "arrangement": [
        { "name": "Chords", "start": 0.0, "length": 64.0 },
        { "name": "Chords", "start": 96.0, "length": 32.0 }
      ],
      "notes": {
        "0": [
          { "pitch": 57, "start": 0.0 },
          { "pitch": 60, "start": 0.0 },
          { "pitch": 64, "start": 0.0 },
          { "pitch": 53, "start": 2.0 },
          { "pitch": 57, "start": 2.0 },
          { "pitch": 60, "start": 2.0 }
        ]
      },
      "arrangementNotes": {
        "0": [
          { "pitch": 57, "start": 0.0 },
          { "pitch": 60, "start": 0.0 },
          { "pitch": 64, "start": 0.0 },
          { "pitch": 53, "start": 2.0 },
          { "pitch": 57, "start": 2.0 },
          { "pitch": 60, "start": 2.0 }
        ],
        "1": [
          { "pitch": 57, "start": 0.0 },
          { "pitch": 60, "start": 0.0 },
          { "pitch": 64, "start": 0.0 },
          { "pitch": 53, "start": 2.0 },
          { "pitch": 57, "start": 2.0 },
          { "pitch": 60, "start": 2.0 }
        ]
      }
    },
    {
      "name": "Drums",
      "volumeDb": "-3.0 dB",
      "volume": 0.80,
      "panning": 0.0,
      "mute": false,
      "solo": false,
      "midi": true,
      "silent": false,
      "clips": [{ "slot": 0, "name": "Beat" }],
      "devices": ["Drum Rack"],
      "racks": [true],
      "deviceDetail": {
        "0": {
          "params": [
            ["Device On", "On"],
            ["Macro 1", "0.0"],
            ["Macro 2", "0.0"]
          ],
          "chains": [
            { "name": "Kick", "note": 36, "devices": ["Simpler"] },
            { "name": "Clap", "note": 39, "devices": ["Simpler"] },
            { "name": "Hats", "note": 42, "devices": ["Simpler"] }
          ]
        }
      },
      "arrangement": [{ "name": "Beat", "start": 0.0, "length": 160.0 }],
      "notes": {
        "0": [
          { "pitch": 36, "start": 0.0 },
          { "pitch": 42, "start": 0.5 },
          { "pitch": 39, "start": 1.0 },
          { "pitch": 42, "start": 1.5 },
          { "pitch": 36, "start": 2.0 },
          { "pitch": 42, "start": 2.5 },
          { "pitch": 39, "start": 3.0 },
          { "pitch": 42, "start": 3.5 }
        ]
      },
      "arrangementNotes": {
        "0": [
          { "pitch": 36, "start": 0.0 },
          { "pitch": 42, "start": 0.5 },
          { "pitch": 39, "start": 1.0 },
          { "pitch": 42, "start": 1.5 },
          { "pitch": 36, "start": 2.0 },
          { "pitch": 42, "start": 2.5 },
          { "pitch": 39, "start": 3.0 },
          { "pitch": 42, "start": 3.5 }
        ]
      }
    },
    {
      "name": "Bass",
      "volumeDb": "-5.0 dB",
      "volume": 0.75,
      "panning": 0.0,
      "mute": false,
      "solo": false,
      "midi": true,
      "silent": false,
      "clips": [],
      "devices": [],
      "racks": [],
      "deviceDetail": {},
      "arrangement": [],
      "notes": {},
      "arrangementNotes": {}
    },
    {
      "name": "Vox",
      "volumeDb": "-8.0 dB",
      "volume": 0.68,
      "panning": 0.0,
      "mute": false,
      "solo": false,
      "midi": false,
      "silent": false,
      "clips": [{ "slot": 0, "name": "Take 3" }],
      "devices": ["Compressor"],
      "racks": [false],
      "deviceDetail": {
        "0": {
          "params": [
            ["Device On", "On"],
            ["Threshold", "-18.0 dB"],
            ["Ratio", "4.00 : 1"],
            ["Attack", "10.0 ms"],
            ["Release", "100 ms"],
            ["Output Gain", "3.0 dB"]
          ]
        }
      },
      "arrangement": [
        { "name": "Take 3", "start": 64.0, "length": 32.0 },
        { "name": "Take 3", "start": 128.0, "length": 32.0 }
      ],
      "notes": {},
      "arrangementNotes": {}
    }
  ]
}
```

- [ ] **Step 3: Write `shared/craft-context.txt`**

The exact render of `buildContext` for that fixture. One trailing newline at the end of the file. The last paragraph is a single line, copied from the last paragraph of `shared/eval-context.txt` byte for byte.

```
SET  132 BPM · A Minor · stopped
SECTIONS (beats)  «Intro» 0, «Drop» 64, «Break» 96, «Drop 2» 128
GOAL  dark garage, 2am

TRACKS  (4)
 0 «Pad» -6.0 dB — selected
 1 «Drums» -3.0 dB
 2 «Bass» -5.0 dB
 3 «Vox» -8.0 dB

This is everything cached locally. For pan, exact fader values, or a track's full mixer state use get_track_detail; for which clips exist and which tracks are MIDI use get_clips; for the notes in a clip use get_clip_notes; for what devices are on each track use get_device_chains; for what is inside a Rack use get_rack_contents; for what plays where on the timeline use get_arrangement; for the notes in a timeline clip use get_arrangement_notes; for one device's parameter values use get_device_params.
```

- [ ] **Step 4: Run the pin**

Run: `npx vitest run src/digest/evalFixture.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t2-pass.log | tail -8`

Expected: 2 passed. If the craft case fails, the diff in the log shows the exact line; fix the text file, never the fixture, unless the fixture itself was mistyped.

- [ ] **Step 5: Run the whole frontend suite**

Run: `npx vitest run 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t2-all.log | tail -5`

Expected: all passed.

- [ ] **Step 6: Commit**

```bash
git add shared/craft-set.json shared/craft-context.txt src/digest/evalFixture.test.ts
git commit -m "Add the craft eval fixture, a clean set with one gap, and pin its context block"
```

---

### Task 3: The fake Live serves the craft fixture in full

**Files:**
- Modify: `src-tauri/tests/common/mod.rs` (`mirror`, `fake_live`)
- Create: `src-tauri/tests/craft.rs` (the no-network test only, for now)
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes the `deviceDetail`, `volume`, and `panning` fixture keys from Task 2.
- Produces a fake that answers `/live/mixingpal/get/device/identity`, `/live/device/get/parameters/name_range`, `/live/device/get/parameters/value_string_range`, and `/live/mixingpal/get/rack/chains` for any device with a `deviceDetail` entry, and stays silent for any device without one. The honesty fixture has no `deviceDetail`, so its drum scenario still sees an unreadable rack.

- [ ] **Step 1: Register the test target**

In `src-tauri/Cargo.toml`, after the existing `[[test]]` block:

```toml
[[test]]
name = "craft"
required-features = ["evals"]
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/tests/craft.rs`:

```rust
//! Craft scenarios: does the advice have the shape the craft ontology asks
//! for? See docs/superpowers/specs/2026-09-02-craft-ontology-design.md.
//!
//! Not run by `cargo test`: the target needs `--features evals`. The first
//! test below costs nothing and needs no credentials: it checks that the
//! fake Live answers every read the craft fixture supports, so a red craft
//! scenario is about the prompt and never about a missing read. Every other
//! test asks a real model, then a judge model, and costs money:
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     [MIXINGPAL_JUDGE_MODEL=...] \
//!     cargo test --features evals --test craft -- --test-threads=1
//!
//! Unlike `evals.rs`, these assert on prose, through a judge. Wording is not
//! stable across runs, so each scenario passes on a majority of three.

mod common;

use mixing_pal_lib::eval_api::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    common::load("craft-set.json")
}

async fn tools() -> ToolContext {
    let f = fixture();
    ToolContext {
        coalescer: common::mirror(&f),
        query: Arc::new(Mutex::new(Some(common::fake_live(f).await))),
    }
}

async fn read(ctx: &ToolContext, name: &str, args: Value) -> Value {
    serde_json::to_value(execute(ctx, name, &args).await).unwrap()
}

#[tokio::test]
async fn the_fake_live_serves_the_craft_fixture_in_full() {
    // The honesty fixture is deliberately broken. This one must not be: a
    // craft scenario that fails because a read came back missing is not a
    // finding about the prompt.
    let ctx = tools().await;
    let reads = [
        ("get_track_detail", json!({ "track": 0 })),
        ("get_clips", json!({})),
        ("get_clip_notes", json!({ "track": 0, "clip": 0 })),
        ("get_arrangement", json!({})),
        ("get_arrangement_notes", json!({ "track": 0, "index": 0 })),
        ("get_device_chains", json!({})),
        ("get_rack_contents", json!({ "track": 1, "path": [0] })),
        ("get_device_params", json!({ "track": 3, "path": [0] })),
    ];
    for (name, args) in reads {
        let r = read(&ctx, name, args.clone()).await;
        assert!(r["missing_reason"].is_null(), "{name} {args}: {r}");
        assert!(!r["value"].is_null(), "{name} {args}: {r}");
    }

    let detail = read(&ctx, "get_track_detail", json!({ "track": 0 })).await.to_string();
    assert!(detail.contains("-6.0 dB"), "the mirror should carry the fader: {detail}");

    let rack = read(&ctx, "get_rack_contents", json!({ "track": 1, "path": [0] })).await.to_string();
    for chain in ["Kick", "Clap", "Hats"] {
        assert!(rack.contains(chain), "{chain} missing from {rack}");
    }

    let comp = read(&ctx, "get_device_params", json!({ "track": 3, "path": [0] })).await.to_string();
    assert!(comp.contains("Threshold") && comp.contains("-18.0 dB"), "{comp}");
}
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd src-tauri
cargo test --features evals --test craft the_fake_live_serves_the_craft_fixture_in_full -- --test-threads=1 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t3-fail.log | grep -E 'panicked|test result|missing_reason' | head
```

Expected: FAIL. Either `get_track_detail` lacks `-6.0 dB` or `get_rack_contents` carries a `missing_reason` (the identity query is unanswered).

- [ ] **Step 4: Teach the mirror the mixer fields**

In `src-tauri/tests/common/mod.rs`, replace the body of `mirror` with:

```rust
pub fn mirror(f: &Value) -> Arc<Mutex<Coalescer>> {
    let mut c = Coalescer::new();
    let tracks = f["tracks"].as_array().unwrap();
    c.observe_delta(Delta {
        addr: "/live/song/get/num_tracks".into(),
        args: vec![json!(tracks.len())],
    });
    // Each field is observed only when the fixture carries it: the honesty
    // fixture has no `volume` or `panning`, and `get_track_detail` reports
    // an absent field as absent rather than as a failed read.
    let fields = [
        ("/live/track/get/name", "name"),
        ("/live/track/get/volume", "volume"),
        ("/live/track/get/volume_db", "volumeDb"),
        ("/live/track/get/panning", "panning"),
        ("/live/track/get/mute", "mute"),
        ("/live/track/get/solo", "solo"),
    ];
    for (i, t) in tracks.iter().enumerate() {
        for (addr, key) in fields {
            if t[key].is_null() {
                continue;
            }
            c.observe_delta(Delta {
                addr: addr.into(),
                args: vec![json!(i), t[key].clone()],
            });
        }
    }
    Arc::new(Mutex::new(c))
}
```

- [ ] **Step 5: Teach the fake the device reads**

In `fake_live`, inside the request loop, after the `float_at` closure and before `let Some(track_index) = int_at(0)`, add:

```rust
            let str_at = |n: usize| match req.args.get(n) {
                Some(OscType::String(s)) => Some(s.clone()),
                _ => None,
            };
```

After `let Some(track) = track_at(track_index) else { continue };` and the `silent` check, add:

```rust
            // A device answers reads only when the fixture describes it.
            // The honesty fixture describes none, so its rack stays
            // unreadable, which its drum scenario depends on.
            let device_detail = || -> Option<(String, Value)> {
                let path = str_at(1)?;
                let detail = track["deviceDetail"].get(path.as_str())?.clone();
                Some((path, detail))
            };
```

Then add these arms to the `match req.addr.as_str()` block, before the final `_ => {}` arm:

```rust
                "/live/mixingpal/get/device/identity" => {
                    let Some((path, detail)) = device_detail() else { continue };
                    let index: usize = path.parse().unwrap_or(usize::MAX);
                    let Some(name) = track["devices"].get(index).and_then(Value::as_str) else {
                        continue;
                    };
                    let total = detail["params"].as_array().map(|p| p.len()).unwrap_or(0);
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                OscType::Int(track_index),
                                OscType::String(path),
                                OscType::String(name.to_string()),
                                OscType::Int(total as i32),
                            ],
                        )
                        .await;
                }
                addr @ ("/live/device/get/parameters/name_range"
                | "/live/device/get/parameters/value_string_range") => {
                    let Some((path, detail)) = device_detail() else { continue };
                    let start = int_at(2).unwrap_or(0).max(0) as usize;
                    let span = int_at(3).unwrap_or(0).max(0) as usize;
                    let column = if addr.ends_with("name_range") { 0 } else { 1 };
                    let params = detail["params"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::String(path),
                        OscType::Int(start as i32),
                    ];
                    for p in params.iter().skip(start).take(span) {
                        reply.push(OscType::String(p[column].as_str().unwrap().to_string()));
                    }
                    let _ = live.send_to(app_port, addr, reply).await;
                }
                "/live/mixingpal/get/rack/chains" => {
                    // `(track, path, start, total_chains, can_have_chains, *records)`,
                    // each record `name, note, mute, solo, total_devices,
                    // reported_devices, *names` -- the shape
                    // `rack_contents::decode_window` reads.
                    let Some((path, detail)) = device_detail() else { continue };
                    let index: usize = path.parse().unwrap_or(usize::MAX);
                    let is_rack = track["racks"].get(index).and_then(Value::as_bool).unwrap_or(false);
                    let start = int_at(2).unwrap_or(0).max(0) as usize;
                    let span = int_at(3).unwrap_or(0).max(0) as usize;
                    let chains = detail["chains"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::String(path),
                        OscType::Int(start as i32),
                        OscType::Int(chains.len() as i32),
                        OscType::Int(is_rack as i32),
                    ];
                    for c in chains.iter().skip(start).take(span) {
                        let devices = c["devices"].as_array().cloned().unwrap_or_default();
                        reply.push(OscType::String(c["name"].as_str().unwrap().to_string()));
                        reply.push(OscType::Int(c["note"].as_i64().unwrap_or(-1) as i32));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Int(devices.len() as i32));
                        reply.push(OscType::Int(devices.len() as i32));
                        for d in &devices {
                            reply.push(OscType::String(d.as_str().unwrap().to_string()));
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
```

Update the doc comment on `fake_live`. It currently says the fake "deliberately does NOT answer `/live/mixingpal/get/device/identity`". Change that paragraph to:

```rust
/// A device answers `/live/mixingpal/get/device/identity`, the parameter
/// windows, and `/live/mixingpal/get/rack/chains` only when its track's
/// `deviceDetail` describes it. `shared/eval-set.json` describes none, so
/// there `get_rack_contents` (`rack_contents.rs`'s `device_identity`
/// bracket) goes unanswered: the drum scenario asserts the model opens the
/// Rack and then reports a named gap instead of concluding there is no
/// compression. Silence is what an unreadable rack looks like from the
/// client's side, and it costs that scenario one query timeout.
/// `shared/craft-set.json` describes every device, and `craft.rs` checks
/// that it reads in full.
```

Also change the final `_ => {}` arm's comment from "including /live/mixingpal/get/device/identity: see the doc comment" to `// an address the fixture cannot answer`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd src-tauri
cargo test --features evals --test craft the_fake_live_serves_the_craft_fixture_in_full -- --test-threads=1 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t3-pass.log | grep -E 'test result|panicked'
```

Expected: `test result: ok. 1 passed`.

If `get_device_params` on the Compressor reports a missing read, check the `DevicePath` wire form: `path.wire()` for `[0]` is the string `"0"`, which is the `deviceDetail` key. If the fake logs show the path arriving as something else, match the key to what arrives rather than changing the tool.

- [ ] **Step 7: Confirm the honesty target still compiles and the ordinary suite still passes**

```bash
cd src-tauri
cargo test --features evals --test evals --no-run 2>&1 | tail -2
cargo test 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t3-cargo-test.log | grep -E 'test result|error'
```

Expected: `Finished`, and every `test result: ok`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tests/common/mod.rs src-tauri/tests/craft.rs
git commit -m "Let the fake Live answer device reads from a fixture, and prove the craft set reads in full"
```

---

### Task 4: The "What a good answer is" section of the prompt

**Files:**
- Modify: `src-tauri/src/model.rs` (`SYSTEM_PROMPT` and its `tests` module)

**Interfaces:**
- Produces the axis names the craft evals' judge properties refer to. The list in the test below is the join between the spec's table and the prompt.

- [ ] **Step 1: Write the failing tripwire tests**

In `src-tauri/src/model.rs`, inside `mod tests`, after `the_prompt_points_at_the_device_tools_by_name`, add:

```rust
    /// The axes come from the craft spec's "Layer 2: the axes" table
    /// (docs/superpowers/specs/2026-09-02-craft-ontology-design.md). That
    /// table is the source and the prompt is derived from it; this list is
    /// the join. Change the table, change this list, and the prompt has to
    /// follow. The two ear-only axes are here too: the prompt must name
    /// them to forbid verdicts on them.
    const CRAFT_AXES: [&str; 9] = [
        "energy contour",
        "contrast at section boundaries",
        "density and space",
        "repetition against variation",
        "low-end ownership",
        "rhythmic relationship",
        "harmonic movement",
        "groove and feel",
        "tone, loudness, and masking",
    ];

    #[test]
    fn the_prompt_names_every_axis_in_the_craft_spec() {
        for axis in CRAFT_AXES {
            assert!(SYSTEM_PROMPT.contains(axis), "the prompt does not name the axis {axis:?}");
        }
    }

    #[test]
    fn the_prompt_carries_the_four_rules_of_a_good_answer() {
        // One phrase per rule in the spec's "Layer 3: the move": section
        // purpose, one move, listen-for, enough.
        for phrase in [
            "what the section",
            "one move",
            "what to listen for",
            "leave them",
        ] {
            assert!(SYSTEM_PROMPT.contains(phrase), "the prompt lost the rule marked by {phrase:?}");
        }
    }

    #[test]
    fn the_craft_section_stays_under_a_third_of_the_honesty_prompt() {
        // 5213 characters before the craft section, measured 2026-09-02.
        // The spec caps growth at a third of that. The prompt rides on
        // every round trip, so this is a cost ceiling, not taste.
        let n = SYSTEM_PROMPT.chars().count();
        assert!(n <= 6950, "the prompt is {n} characters; the ceiling is 6950");
    }
```

- [ ] **Step 2: Run them to verify the first two fail and the third passes**

```bash
cd src-tauri
cargo test --lib model::tests::the_prompt_names_every_axis 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t4-fail.log | grep -E 'test result|does not name'
cargo test --lib model::tests::the_prompt_carries_the_four_rules 2>&1 | grep -E 'test result|lost the rule'
cargo test --lib model::tests::the_craft_section_stays 2>&1 | grep 'test result'
```

Expected: the first two FAIL naming `"energy contour"` and `"what the section"`; the third passes.

- [ ] **Step 3: Add the section to the prompt**

In `SYSTEM_PROMPT`, insert this block after the line `- Answer briefly. The producer is working, not reading.` and before `Untrusted data:`. Keep the same line-continuation style (`\` at the end of each wrapped line, one blank line before the heading).

```rust
What a good answer is:
- A track is judged on a few axes. Readable from notes and settings: energy \
contour across sections; contrast at section boundaries; density and space \
(how many things play at once, in which registers); repetition against \
variation; low-end ownership (one element owns the sub); rhythmic \
relationship (what locks, what pushes); harmonic movement. Ear-only, which \
you cannot judge: groove and feel; tone, loudness, and masking. On a \
readable axis, say what the claim rests on. On an ear-only axis give no \
verdict: name the question and hand it to the producer.
- The GOAL line is the target. Whatever it names - a genre, an artist, a \
mood, a reference - say in one sentence what the section or element in \
question is for in that world before you diagnose. If there is no GOAL, \
ask for one instead of guessing.
- Give one move, the biggest gap first. Name the axis it moves and the why \
in that axis's terms. Make it reversible and under a minute in Live.
- End every move with what to listen for: where to play from and what to \
notice. The producer is the ear.
- Say what is enough. Name the axes that are fine and say to leave them. If \
nothing is wrong on a readable axis, say so and stop. Never invent a change \
to have something to say.

```

- [ ] **Step 4: Run the whole `model` test module**

```bash
cd src-tauri
cargo test --lib model::tests 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t4-pass.log | grep -E 'test result|FAILED|panicked'
```

Expected: `test result: ok` with every existing prompt test still green, the three new ones included. If `the_craft_section_stays_under_a_third_of_the_honesty_prompt` fails, cut words from the section; do not raise the ceiling.

- [ ] **Step 5: Run the whole Rust suite**

```bash
cd src-tauri && cargo test 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t4-all.log | grep -E 'test result|error'
```

Expected: every `test result: ok`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/model.rs
git commit -m "Tell the model what a good answer is: the axes, the goal as target, one move, and enough"
```

---

### Task 5: The judge, the majority runner, and the first craft scenario

**Files:**
- Modify: `src-tauri/src/lib.rs` (`eval_api`)
- Modify: `src-tauri/tests/craft.rs`

**Interfaces:**
- Consumes `common::ask`, `common::context`, `common::settings` from Task 1 and `post_chat` from `model.rs`.
- Produces, in `craft.rs`: `struct Property { key, description }`, the property constants, `struct Scenario { question, goal, mentor, must }`, `async fn tally(sc: &Scenario, extra: impl Fn(&Run) -> bool) -> (usize, String)`, and `async fn passes_majority(sc, extra)`. Task 6 adds scenarios on top of these.

- [ ] **Step 1: Re-export `post_chat`**

In `src-tauri/src/lib.rs`, change the `eval_api` line that re-exports from `model` to:

```rust
    pub use crate::model::{complete, post_chat, ChatMessage, Completion, ToolCall, REMINDER, SYSTEM_PROMPT};
```

`post_chat` is already `pub` in `model.rs`. It posts a caller-built body, which is what a judge call needs: the copilot's system prompt and tool schema must not ride along.

- [ ] **Step 2: Add the judge, the runner, and scenario 1 to `craft.rs`**

Append to `src-tauri/tests/craft.rs`:

```rust
use std::collections::BTreeMap;

/// One thing the judge looks for. `description` is what the judge reads;
/// `key` is what it answers under.
struct Property {
    key: &'static str,
    description: &'static str,
}

const SECTION_PURPOSE: Property = Property {
    key: "section_purpose",
    description: "States, in about one sentence, what the section or element in question is for in the world the GOAL line names. Judge only that the statement is present and tied to the GOAL. Never judge whether it is true.",
};
const NAMED_AXIS: Property = Property {
    key: "named_axis",
    description: "Diagnoses on one named axis: energy contour, contrast at section boundaries, density and space, repetition against variation, low-end ownership, rhythmic relationship, or harmonic movement.",
};
const ONE_MOVE: Property = Property {
    key: "one_move",
    description: "Proposes exactly one concrete move. A list of alternatives fails.",
};
const WHY: Property = Property {
    key: "why",
    description: "Gives the reason for the move in terms of the axis it moves, not as a bare instruction.",
};
const LISTEN_FOR: Property = Property {
    key: "listen_for",
    description: "Ends with a test the producer performs by ear: where to play from and what to notice.",
};
const LEAVE_IT: Property = Property {
    key: "leave_it",
    description: "Names at least one thing that is fine and says to leave it alone.",
};
const RANKED: Property = Property {
    key: "ranked",
    description: "Says why this move comes first: what makes it the biggest gap.",
};
const VERDICT_LEAVE: Property = Property {
    key: "verdict_leave",
    description: "The verdict is to leave the pad as it is.",
};
const READABLE_SOURCE: Property = Property {
    key: "readable_source",
    description: "Every claim about the set names what it rests on: the notes, the arrangement, or device settings.",
};
const NO_INVENTED_CHANGE: Property = Property {
    key: "no_invented_change",
    description: "Does not propose changing anything it has not found a problem with.",
};
const EAR_ONLY_HANDED_OVER: Property = Property {
    key: "ear_only_handed_over",
    description: "Gives no verdict on tone, loudness, masking, groove, or feel. Where those come up, it hands the question to the producer.",
};
const CONDITIONAL_MOVE: Property = Property {
    key: "conditional_move",
    description: "Any move it gives is stated as waiting on something not yet done, or it gives no move at all.",
};
const MOVEMENT_DESIRABLE: Property = Property {
    key: "movement_desirable",
    description: "Treats the pad's harmonic movement, the chords changing, as something to keep or increase rather than to reduce or remove.",
};

const JUDGE_PROMPT: &str = "\
You grade one answer from a music-production copilot against a list of \
properties. The copilot cannot hear the set; it reads notes and settings. \
You are given the producer's question, the context block the copilot saw, \
a mentor answer that shows the bar, the answer under test, and the \
properties. The mentor answer is a reference for quality, not a key: an \
answer that reaches a different conclusion by a sound argument passes the \
same properties. Never grade whether a claim about a genre or a style is \
true. Reply with JSON only, no prose around it: an object with one entry \
per property key, each {\"pass\": true or false, \"reason\": \"one sentence\"}.";

struct Scenario {
    question: &'static str,
    /// `None` keeps the fixture's goal; `Some` replaces the GOAL line.
    goal: Option<&'static str>,
    mentor: &'static str,
    must: &'static [Property],
}

fn judge_settings() -> Settings {
    let s = common::settings();
    Settings {
        model: std::env::var("MIXINGPAL_JUDGE_MODEL").unwrap_or_else(|_| s.model.clone()),
        ..s
    }
}

/// `(pass, reason)` per property key. A judge reply that cannot be parsed
/// fails every property, with the raw text as the reason, so a broken
/// judge shows up as red runs with its output attached, never as green.
async fn judge(
    question: &str,
    context: &str,
    answer: &str,
    mentor: &str,
    props: &[Property],
) -> BTreeMap<String, (bool, String)> {
    let list = props
        .iter()
        .map(|p| format!("- {}: {}", p.key, p.description))
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "QUESTION\n{question}\n\nCONTEXT BLOCK THE COPILOT SAW\n{context}\n\n\
         MENTOR ANSWER (the bar, not the key)\n{mentor}\n\n\
         ANSWER UNDER TEST\n{answer}\n\nPROPERTIES\n{list}"
    );
    let s = judge_settings();
    let body = json!({
        "model": s.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": JUDGE_PROMPT },
            { "role": "user", "content": user },
        ],
    });
    let raw = post_chat(&reqwest::Client::new(), &s, body).await.expect("the judge answered");
    let content = raw["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    let parsed = match (content.find('{'), content.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str(&content[a..=b]).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    props
        .iter()
        .map(|p| {
            let v = &parsed[p.key];
            let pass = v["pass"].as_bool().unwrap_or(false);
            let reason = v["reason"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("no verdict; judge said: {content}"));
            (p.key.to_string(), (pass, reason))
        })
        .collect()
}

fn context_for(goal: Option<&str>) -> String {
    let base = common::context("craft-context.txt");
    let Some(goal) = goal else { return base };
    let line = "GOAL  dark garage, 2am";
    assert!(base.contains(line), "the fixture's GOAL line moved; update `context_for`");
    base.replace(line, &format!("GOAL  {goal}"))
}

struct Run {
    answer: String,
    called: Vec<String>,
    verdicts: BTreeMap<String, (bool, String)>,
}

async fn run_once(sc: &Scenario) -> Run {
    let context = context_for(sc.goal);
    let turn = common::ask(fixture(), &context, sc.question).await;
    assert!(!turn.truncated, "ran out of round trips: {:?}", turn.called);
    assert!(!turn.answer.trim().is_empty(), "the provider returned an empty final message");
    let verdicts = judge(sc.question, &context, &turn.answer, sc.mentor, sc.must).await;
    Run { answer: turn.answer, called: turn.called, verdicts }
}

const RUNS: usize = 3;

/// Runs the scenario `RUNS` times. A run passes when every property passes
/// and `extra` holds (tool-call checks live there, the judge never sees
/// tool calls). Returns the pass count and a report of every run, so a red
/// scenario shows the answers and the judge's reasons in one place.
async fn tally(sc: &Scenario, extra: impl Fn(&Run) -> bool) -> (usize, String) {
    let mut passes = 0;
    let mut report = String::new();
    for i in 0..RUNS {
        let run = run_once(sc).await;
        let ok = run.verdicts.values().all(|(p, _)| *p) && extra(&run);
        passes += ok as usize;
        report.push_str(&format!(
            "\n--- run {i}: {} tools {:?}\n{}\n{:#?}\n",
            if ok { "PASS" } else { "FAIL" },
            run.called,
            run.answer,
            run.verdicts
        ));
    }
    (passes, report)
}

async fn passes_majority(sc: &Scenario, extra: impl Fn(&Run) -> bool) {
    let (passes, report) = tally(sc, extra).await;
    assert!(passes * 2 > RUNS, "{passes}/{RUNS} runs passed:{report}");
}

// Scenario 1. The gap the fixture was built around: the drop is the only
// place the pad leaves, and the bass that should arrive has not been
// written. The mentor's claim about what a garage drop is for is an
// illustration of the section-purpose rule, not a fact this repo holds.
const DROP_FALLS_FLAT: Scenario = Scenario {
    question: "why does the drop fall flat?",
    goal: None,
    mentor: "The drop is the first place the pad leaves, and nothing arrives in its place: the Bass track is empty. So the drop is the thinnest bar of the track, when in garage it should be the fullest. One move: write a bass for 64 to 96 that owns the sub, on the roots of your pad chords, A and F, and keep it out of the intro so the arrival is the contrast. Play from 60 and listen for whether bar 64 feels like a landing or a gap. Leave the drums alone; running through is the right thing for them to do.",
    must: &[SECTION_PURPOSE, NAMED_AXIS, ONE_MOVE, WHY, LISTEN_FOR, LEAVE_IT],
};

#[tokio::test]
async fn why_does_the_drop_fall_flat() {
    passes_majority(&DROP_FALLS_FLAT, |run| {
        run.called.iter().any(|c| c == "get_arrangement")
    })
    .await;
}
```

- [ ] **Step 3: Compile the craft target and re-run the no-network test**

```bash
cd src-tauri
cargo test --features evals --test craft the_fake_live_serves_the_craft_fixture_in_full -- --test-threads=1 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t5-build.log | grep -E 'warning|error|test result'
```

Expected: no warnings, no errors, `1 passed`. The scenario test is compiled but filtered out, so nothing hits the network.

- [ ] **Step 4: Run scenario 1 against a real model, if credentials are in the environment**

This step spends the operator's provider quota. Run it only if `MIXINGPAL_EVAL_KEY` is set in the shell; if it is not, skip to Step 5 and say so in the task report.

```bash
cd src-tauri
cargo test --features evals --test craft why_does_the_drop_fall_flat -- --test-threads=1 --nocapture 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t5-scenario1.log | grep -E 'runs passed|test result|panicked'
```

Expected: `test result: ok`. If it is red, the report in the log holds all three answers with the judge's reason per property. A property that fails on all three runs is a prompt finding: fix the prompt section in `model.rs`, not the property. A property that fails on one run is noise the majority absorbs. A `no verdict; judge said:` reason means the judge did not return JSON; check `MIXINGPAL_JUDGE_MODEL`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tests/craft.rs
git commit -m "Judge craft answers by property, majority of three, starting with the flat drop"
```

---

### Task 6: The remaining scenarios and the verification record

**Files:**
- Modify: `src-tauri/tests/craft.rs`
- Modify: `docs/manual-verification.md`

**Interfaces:**
- Consumes `Scenario`, the `Property` constants, `tally`, `passes_majority`, and `RUNS` from Task 5.

- [ ] **Step 1: Add scenarios 2 to 5**

Append to `src-tauri/tests/craft.rs`:

```rust
// Scenario 2. One move, ranked, with two things named as enough.
const WHAT_NEXT: Scenario = Scenario {
    question: "what should I do next?",
    goal: None,
    mentor: "The biggest hole is the low end: the Bass track has nothing on it, and at 132 in garage the sub is what the drop stands on. Write a bass part for 64 to 96, root notes following the pad's A and F, and keep it out of the intro. Then play 60 to 68 and listen for whether the drop lands. The drums and the pad are fine as they are; do not touch them yet.",
    must: &[ONE_MOVE, RANKED, WHY, LISTEN_FOR, LEAVE_IT],
};

#[tokio::test]
async fn what_should_i_do_next() {
    passes_majority(&WHAT_NEXT, |run| {
        run.called.iter().any(|c| c == "get_arrangement")
    })
    .await;
}

// Scenario 3. Nothing is wrong. The right answer reads the notes and says
// leave it; an invented change fails.
const PAD_TOO_BUSY: Scenario = Scenario {
    question: "is the pad too busy?",
    goal: None,
    mentor: "No. Two triads trading every two beats is one idea, held, and for dark garage that stillness is the point. It never plays under the vocal either, so nothing is fighting it. Leave it. If anything feels crowded later, it will be in the drop, and the pad is not there.",
    must: &[VERDICT_LEAVE, READABLE_SOURCE, NO_INVENTED_CHANGE],
};

#[tokio::test]
async fn is_the_pad_too_busy() {
    // The verdict has to rest on the notes, so a read of them is required.
    // Either read path is fine: the session clip or the timeline clip.
    passes_majority(&PAD_TOO_BUSY, |run| {
        run.called
            .iter()
            .any(|c| c == "get_clip_notes" || c == "get_arrangement_notes")
    })
    .await;
}

// Scenario 4. Ear-only axes handed over, one readable observation with its
// source, and no problem invented to fill the answer.
const MIX_OKAY: Scenario = Scenario {
    question: "is the mix okay?",
    goal: None,
    mentor: "From the settings, there is almost no processing to judge: one compressor on the vocal and nothing on the pad, drums, or bass. Levels sit in a normal spread. Whether it is loud enough or whether anything masks is yours to hear; I cannot. The one thing I can see is that the pad has no high-pass, so once you write the bass the two will share the low end. That is the first mix move, and it waits for the bass. For now there is nothing to fix.",
    must: &[EAR_ONLY_HANDED_OVER, READABLE_SOURCE, NO_INVENTED_CHANGE, CONDITIONAL_MOVE],
};

#[tokio::test]
async fn is_the_mix_okay() {
    passes_majority(&MIX_OKAY, |run| {
        run.called.iter().any(|c| c == "get_device_chains")
    })
    .await;
}

// Scenario 5. Same set, same question, two goals. This is the eval that
// proves the GOAL line does work: the answers must differ on harmonic
// movement. Neither mentor's claim about its style is a fact this repo
// holds; each illustrates the shape of an answer that took its goal
// seriously.
const CHORDS_GARAGE: Scenario = Scenario {
    question: "the pad chords, keep or change?",
    goal: None,
    mentor: "Keep them. A minor to F trading every two beats is the dark, 2am pull; the movement is the mood. Nothing to change on the pad. The gap is elsewhere: the Bass track is still empty.",
    must: &[MOVEMENT_DESIRABLE],
};

const CHORDS_TECHNO: Scenario = Scenario {
    question: "the pad chords, keep or change?",
    goal: Some("minimal techno, peak time"),
    mentor: "Stop them moving. For peak-time minimal techno the pad's job is a held texture, not a progression. Keep one chord, the A minor, through the drop and let the drums and a filter carry the movement. Play 64 to 96 and listen for whether it locks in harder once the harmony stands still. The drums are fine; leave them.",
    must: &[MOVEMENT_DESIRABLE],
};

#[tokio::test]
async fn the_goal_changes_the_advice() {
    let (garage_yes, garage_report) = tally(&CHORDS_GARAGE, |_| true).await;
    let (techno_yes, techno_report) = tally(&CHORDS_TECHNO, |_| true).await;
    // Garage: movement desirable on a majority. Techno: NOT desirable on
    // a majority. The scenario passes only when the two verdicts differ.
    assert!(
        garage_yes * 2 > RUNS,
        "under the garage goal, movement should read as desirable: {garage_yes}/{RUNS}{garage_report}"
    );
    assert!(
        (RUNS - techno_yes) * 2 > RUNS,
        "under the techno goal, movement should not read as desirable: {techno_yes}/{RUNS}{techno_report}"
    );
}
```

- [ ] **Step 2: Compile the target and re-run the no-network test**

```bash
cd src-tauri
cargo test --features evals --test craft the_fake_live_serves_the_craft_fixture_in_full -- --test-threads=1 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t6-build.log | grep -E 'warning|error|test result'
```

Expected: no warnings, no errors, `1 passed`.

- [ ] **Step 3: Run every craft scenario against a real model, if credentials are in the environment**

Same rule as Task 5 Step 4: only with `MIXINGPAL_EVAL_KEY` set, and say so in the task report if skipped.

```bash
cd src-tauri
cargo test --features evals --test craft -- --test-threads=1 --nocapture 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t6-craft.log | grep -E 'runs passed|should|test result|panicked'
```

Expected: `test result: ok. 6 passed`. Read a red scenario's report before touching anything: three-of-three failures on one property are a prompt finding; one-of-three is noise.

- [ ] **Step 4: Record the craft evals in `docs/manual-verification.md`**

Append after the "Model evals" section's checklist (the end of the file):

```markdown

## Craft evals

Status: **PENDING-USER**. `src-tauri/tests/craft.rs` is written and its
no-network test passes (`the_fake_live_serves_the_craft_fixture_in_full`),
but the five scenarios below have not been run against a real provider by
the suite that wrote them, for the same reason as the model evals above.

These check the *shape* of the advice, not which tools were called: a judge
model scores each answer against named properties (one move, the why, what
to listen for, what to leave alone, and so on), and a scenario passes on a
majority of three runs. The spec is
`docs/superpowers/specs/2026-09-02-craft-ontology-design.md`.

Run before each release, after the model evals:

```bash
cd src-tauri && MIXINGPAL_EVAL_BASE_URL=https://openrouter.ai/api/v1 \
  MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
  cargo test --features evals --test craft -- --test-threads=1
```

`MIXINGPAL_JUDGE_MODEL` names the judge; it defaults to the eval model. A
judge should be at least as strong as the model it grades.

This costs more than the model evals: 6 scenario tallies of 3 runs each
(the goal scenario tallies twice), so 18 turns of up to 6 round trips plus
18 judge calls, roughly 126 completions in the worst case.

A red scenario prints every run's answer and the judge's reason per
property. A property failing three of three runs is a prompt finding. One
of three is noise the majority absorbs. A reason beginning `no verdict;
judge said:` means the judge did not return JSON: check the judge model.

The mentor answers in `craft.rs` illustrate the shape of a good answer. The
claims they make about garage or techno are not facts this repo stands
behind, and the judge is told not to grade them.

Date: ___________  Model: ___________  Judge: ___________

- [ ] why does the drop fall flat
- [ ] what should I do next
- [ ] is the pad too busy
- [ ] is the mix okay
- [ ] the goal changes the advice
```

- [ ] **Step 5: Run every suite once more**

```bash
cd src-tauri && cargo test 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t6-cargo.log | grep -E 'test result|error'
cd .. && npx vitest run 2>&1 | tee /private/tmp/claude-501/-Users-palg-Projects-ideas-ableton-copilot/3d5a0885-e53d-4b2b-bbd3-bd2952ce2652/scratchpad/t6-vitest.log | tail -4
npm run build 2>&1 | tail -3
```

Expected: every Rust `test result: ok`, vitest all passed, build clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tests/craft.rs docs/manual-verification.md
git commit -m "Finish the craft scenarios and record how to run them"
```

---

## Self-review against the spec

- **Layer 2 axes and tags:** Task 4 prompt section names all nine, split readable and ear-only. `CRAFT_AXES` is the join.
- **Layer 3 four rules:** Task 4 section, one bullet each; `the_prompt_carries_the_four_rules_of_a_good_answer` pins them.
- **Where it lives:** the spec is the source, the prompt is derived, the tripwire test is the join. Goal field untouched. Done in Task 4.
- **Prose judging, separate file, same feature and variables, majority of three, properties not similarity:** Tasks 5 and 6. `craft.rs` is its own target under `evals`.
- **Craft fixture:** Task 2, matching the spec's set (goal, tempo, key, four locators, four tracks as described). Note: Bass has no `silent` flag and answers reads.
- **Five scenarios with properties:** Task 5 (scenario 1) and Task 6 (2 to 5). Scenario 3 carries a tool-call assertion as the spec asks. Scenario 5 passes only when the verdicts differ.
- **The judge:** Task 5. JSON booleans plus a reason, sees question, context, answer, mentor, properties, never the tool calls. `MIXINGPAL_JUDGE_MODEL` overrides.
- **Acceptance:** section present (Task 4), tripwire (Task 4), fixture read in full (Task 3), scenarios recorded in `manual-verification.md` (Task 6), honesty tests still pass (Task 4 Step 4), growth under a third (Task 4 test).
- **No genre facts:** the prompt lists no genres; the mentor answers are marked as illustrations in code comments, the judge prompt, and the verification doc.
- **Type consistency:** `common::load`, `common::context`, `common::ask(f, context, question)`, `common::mirror`, `common::fake_live`, `common::settings` are used with the same signatures in Tasks 1, 3, 5. `tally` returns `(usize, String)` and `passes_majority` wraps it; Task 6 uses both. `Property` and `Scenario` field names match across Tasks 5 and 6.
