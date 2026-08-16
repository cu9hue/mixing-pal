import { describe, it, expect } from "vitest";
import { SONG_FIELDS, TRACK_FIELDS } from "./apply";
import manifest from "../../shared/handled-addresses.json";

// This file is one half of the address-consistency tripwire from I4 in the
// 2026-08-16 whole-branch review: shared/handled-addresses.json is the
// declared ground truth for what apply.ts maps, and src-tauri/src/lib.rs's
// own test asserts that manifest against EMITTED_ADDRESSES (what the
// backend actually sends). A pure-Rust test cannot see this file's actual
// SONG_FIELDS/TRACK_FIELDS objects, so this test is what keeps the manifest
// honest: if apply.ts's mapping changes without updating the manifest, this
// fails; if the manifest changes without updating apply.ts, this also
// fails. Either way, a drift between the two sides fails the build instead
// of shipping silently -- which is exactly the class of bug that let C1
// (a rendered field nothing ever fetched) ship.
describe("shared/handled-addresses.json", () => {
  it("matches the addresses apply.ts actually maps", () => {
    expect(Object.keys(SONG_FIELDS).sort()).toEqual(
      [...manifest.songFields].sort(),
    );
    expect(Object.keys(TRACK_FIELDS).sort()).toEqual(
      [...manifest.trackFields].sort(),
    );
  });
});
