import { describe, it, expect } from "vitest";
import { readingLog, Read } from "./readingLog";
import { emptySet } from "../live/apply";
import { emptyTrack } from "../live/model";

const NAMES = ["909 Kick", "Clap", "Closed Hat", "Open Hat", "FM Bass", "Pad", "Lead", "Vox"];
const STATE = {
  ...emptySet(),
  tracks: Object.fromEntries(NAMES.map((name, i) => [i, { ...emptyTrack(), name }])),
};

const done = (name: string, args: unknown = {}): Read => ({ name, args, done: true });
const running = (name: string, args: unknown = {}): Read => ({ name, args, done: false });
const texts = (reads: Read[]) => readingLog(reads, STATE).map((l) => l.text);

describe("readingLog", () => {
  it("is empty before the first read", () => {
    expect(readingLog([], STATE)).toEqual([]);
  });

  it("puts a finished read in the past tense and a running read in the present", () => {
    expect(readingLog([done("get_clip_notes", { track: 4, clip: 0 })], STATE)).toEqual([
      { text: "read the notes in FM Bass", check: true },
    ]);
    expect(readingLog([running("get_clip_notes", { track: 5, clip: 0 })], STATE)).toEqual([
      { text: "reading the notes in Pad…", check: false },
    ]);
  });

  it("keeps reads in the order they began", () => {
    expect(texts([
      done("get_arrangement"),
      done("get_clip_notes", { track: 4, clip: 0 }),
      running("get_clip_notes", { track: 5, clip: 0 }),
    ])).toEqual(["mapped the arrangement", "reading the notes in FM Bass and Pad…"]);
  });

  it("past tense for every tool, with and without a track", () => {
    expect(texts([
      done("get_track_detail", { track: 1 }), done("get_clip_notes", { track: 1, clip: 0 }),
      done("get_arrangement_notes", { track: 1, index: 0 }), done("get_device_params", { track: 1, path: "0" }),
    ])).toEqual([
      "read Clap", "read the notes in Clap", "read the arrangement notes in Clap", "looked at a device on Clap",
    ]);
    expect(texts([
      done("get_rack_contents", { track: 1, path: "0" }), done("get_mixer", { track: 1 }), done("get_arrangement", { track: 1 }),
    ])).toEqual(["opened the rack on Clap", "read the mixer for Clap", "mapped the arrangement for Clap"]);
    const bare = ["get_track_detail", "get_clip_notes", "get_arrangement_notes", "get_device_params",
      "get_rack_contents", "get_clips", "get_arrangement", "get_device_chains", "get_mixer"];
    // One call per tool: nine lines in one log would fold.
    expect(bare.map((n) => texts([done(n)])[0])).toEqual([
      "read a track", "read the clip", "read an arrangement clip", "looked at a device",
      "opened a rack", "listed the clips", "mapped the arrangement", "listed the devices", "read the mixer",
    ]);
  });

  it("merges reads with one verb into a line that names the tracks", () => {
    expect(texts([done("get_track_detail", { track: 0 }), done("get_track_detail", { track: 1 })])).toEqual(["read 909 Kick and Clap"]);
    expect(texts([0, 1, 2].map((track) => done("get_track_detail", { track })))).toEqual(["read 909 Kick, Clap and Closed Hat"]);
  });

  it("names at most three tracks, then counts the rest", () => {
    const reads = NAMES.map((_, track) => done("get_arrangement", { track }));
    expect(texts(reads)).toEqual(["mapped the arrangement for 909 Kick, Clap, Closed Hat and 5 more"]);
  });

  it("lists a track once when the same tool read it twice", () => {
    expect(texts([
      done("get_arrangement_notes", { track: 4, index: 0 }),
      running("get_arrangement_notes", { track: 4, index: 1 }),
    ])).toEqual(["reading the arrangement notes in FM Bass…"]);
  });

  it("a merged line is in progress until every read in it has finished", () => {
    expect(readingLog([done("get_mixer", { track: 0 }), running("get_mixer", { track: 1 })], STATE)).toEqual([
      { text: "reading the mixer for 909 Kick and Clap…", check: false },
    ]);
  });

  it("falls back to the plain phrase when any read in the group names no track", () => {
    expect(texts([done("get_arrangement"), done("get_arrangement", { track: 1 })])).toEqual(["mapped the arrangement"]);
    expect(texts([done("get_clip_notes", { track: 99, clip: 0 })])).toEqual(["read the clip"]);
  });

  it("shows the last four lines and folds the rest into the first", () => {
    const tools = ["get_clips", "get_arrangement", "get_device_chains", "get_mixer", "get_track_detail"];
    expect(readingLog(tools.map((n) => done(n)), STATE)).toEqual([
      { text: "+2 earlier reads", check: false },
      { text: "listed the devices", check: true },
      { text: "read the mixer", check: true },
      { text: "read a track", check: true },
    ]);
    expect(texts(tools.slice(0, 4).map((n) => done(n)))).toHaveLength(4);
  });

  it("never shows a tool name or raw arguments, even for a tool it does not know", () => {
    expect(texts([done("get_future_thing", { track: 1 }), running("get_other_thing", { x: 1 })])).toEqual([
      "read something", "reading…",
    ]);
    for (const line of texts([done("get_future_thing", { track: 1 })])) {
      expect(line).not.toContain("_");
      expect(line).not.toContain("{");
    }
  });
});
