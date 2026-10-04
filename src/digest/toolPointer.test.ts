import { describe, expect, it } from "vitest";
import { buildContext } from "./build";
import { SetState } from "../live/model";
import modRs from "../../src-tauri/src/tools/mod.rs?raw";

// A source-reading tripwire, not a unit test. The tool schema lives in Rust
// and the sentence that points at it lives here, with no type-level relation
// between them -- so adding a tool and forgetting this sentence is a silent
// loss: the model never learns the tool exists unless it reads the schema
// closely, and the digest actively tells it what the alternatives are.
function schemaToolNames(): string[] {
  const names = [...modRs.matchAll(/"name":\s*"(get_[a-z_]+)"/g)].map((m) => m[1]);
  return [...new Set(names)];
}

const EMPTY: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: null,
  rootNote: null,
  signatureNumerator: null,
  signatureDenominator: null,
  selectedTrack: null,
  tracks: {},
  scriptVersion: 4,
  cuePoints: [],
  cuePointsTotal: null,
  setId: null,
  setName: null,
  setPath: null,
  loop: null,
  loopStart: null,
  loopLength: null,
  selectedDevice: null,
  selectedSlot: null,
};

describe("the digest's tool pointer", () => {
  it("finds the tool names in the Rust schema", () => {
    // Guards the regex itself: a schema reformat that breaks the match
    // would otherwise make the test below vacuously pass.
    expect(schemaToolNames().length).toBeGreaterThanOrEqual(8);
  });

  it("names every tool the schema offers", () => {
    const context = buildContext(EMPTY, "");
    for (const name of schemaToolNames()) {
      // A plain toContain would pass vacuously for "get_arrangement" if only
      // "get_arrangement_notes" were named -- one is a substring of the
      // other. \b requires a non-word boundary, and "_" is a word
      // character, so this only matches the name on its own.
      expect(context).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
