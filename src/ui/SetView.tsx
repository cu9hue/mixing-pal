import { useState } from "react";
import { SetState } from "../live/model";
import { keyName } from "../digest/build";
import { Connection } from "./Connection";

// Same persistence pattern as Chat.tsx's GOAL_STORAGE_KEY: survive a webview
// reload, and never let a storage failure take the component down with it.
const TRACKS_EXPANDED_KEY = "copilot.tracksExpanded";

function loadStoredExpanded(): boolean {
  try {
    return localStorage.getItem(TRACKS_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(TRACKS_EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // Best-effort only -- see loadStoredExpanded.
  }
}

// Same honest-unknown wording as src/digest/build.ts's SET line: "tempo
// unknown" rather than "0 BPM", "no key set" rather than a guessed key. Kept
// in sync by calling keyName directly instead of re-deriving it.
function summaryLine(state: SetState, trackCount: number): string {
  const tempo = state.tempo === null ? "tempo unknown" : `${state.tempo} BPM`;
  const key = keyName(state.rootNote, state.scaleName) ?? "no key set";
  return `${trackCount} track${trackCount === 1 ? "" : "s"} · ${tempo} · ${key}`;
}

export function SetView({ state, lastSeen }: { state: SetState; lastSeen: number | null }) {
  const [expanded, setExpanded] = useState(loadStoredExpanded);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div style={{ font: "13px ui-monospace, monospace", padding: 10 }}>
      {/* Must stay visible whether the table below is expanded or not --
          hiding "Not connected to Live" behind a collapsed section would be
          exactly the wrong failure mode. */}
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} />
      <details
        open={expanded}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setExpanded(isOpen);
          saveExpanded(isOpen);
        }}
      >
        <summary style={{ cursor: "pointer", marginBottom: 8 }}>
          {summaryLine(state, indices.length)}
        </summary>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingRight: 12 }}>#</th>
              <th style={{ textAlign: "left", paddingRight: 12 }}>name</th>
              {/* The formatted dB string straight from Live's own fader
                  readout, carried by mixer_data since Plan 2 Task 2. */}
              <th style={{ textAlign: "left", paddingRight: 12 }}>fader</th>
              <th style={{ textAlign: "left", paddingRight: 12 }}>mute</th>
              <th style={{ textAlign: "left" }}>solo</th>
            </tr>
          </thead>
          <tbody>
            {indices.map((i) => (
              <tr
                key={i}
                style={{
                  fontWeight: state.selectedTrack === i ? "bold" : "normal",
                }}
              >
                <td style={{ paddingRight: 12 }}>{i}</td>
                <td style={{ paddingRight: 12 }}>{state.tracks[i].name ?? "—"}</td>
                <td style={{ paddingRight: 12 }}>{state.tracks[i].volumeDb ?? "—"}</td>
                <td style={{ paddingRight: 12 }}>{state.tracks[i].mute ? "M" : ""}</td>
                <td>{state.tracks[i].solo ? "S" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
