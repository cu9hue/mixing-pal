import { useState } from "react";
import "./WhatICanSee.css";
import { SetState } from "../live/model";
import { summaryLine } from "./summaryLine";
import { Advanced } from "./Advanced";
import wireVersion from "../../shared/wire-version.json";

// Same persistence pattern as the goal: survive a webview reload, and never
// let a storage failure take the component down with it.
const EXPANDED_KEY = "copilot.tracksExpanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // Best-effort only -- see loadExpanded.
  }
}

/**
 * Everything Live already shows, in the one place it earns its keep.
 *
 * The producer does not need a worse copy of her own track list while she
 * works. She does need to be able to check that this app is really reading
 * her set when an answer looks wrong -- and that is what this is for.
 * Collapsed by default, and it stays that way.
 */
export function WhatICanSee({ state }: { state: SetState }) {
  const [expanded, setExpanded] = useState(loadExpanded);
  // The one door to Advanced, and the only way to enter an API key. It is
  // deliberately not persisted: this pane is a pressure valve, not a place
  // to leave open. Advanced replaces the panel rather than sitting under
  // it, because the card is 520px tall at the very most.
  const [advanced, setAdvanced] = useState(false);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <details
      className="wics"
      open={expanded}
      onToggle={(e) => {
        const isOpen = e.currentTarget.open;
        setExpanded(isOpen);
        saveExpanded(isOpen);
      }}
    >
      <summary className="wics__summary">What I can see</summary>
      <div className={`wics__panel${advanced ? " wics__panel--advanced" : ""}`}>
        {advanced ? (
          <Advanced scriptVersion={state.scriptVersion} onClose={() => setAdvanced(false)} />
        ) : (
          <>
            <div className="wics__line">{summaryLine(state, indices.length)}</div>
            <div className="wics__line">
              connector v{state.scriptVersion ?? "—"} · this app expects v{wireVersion.version}
            </div>
            <table className="wics__table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>name</th>
                  {/* The formatted dB string straight from Live's own fader
                      readout, carried by mixer_data. */}
                  <th>fader</th>
                  <th>m</th>
                  <th>s</th>
                </tr>
              </thead>
              <tbody>
                {indices.map((i) => (
                  <tr
                    key={i}
                    className={state.selectedTrack === i ? "wics__row--selected" : undefined}
                  >
                    <td>{i}</td>
                    <td>{state.tracks[i].name ?? "—"}</td>
                    <td>{state.tracks[i].volumeDb ?? "—"}</td>
                    <td>{state.tracks[i].mute ? "M" : ""}</td>
                    <td>{state.tracks[i].solo ? "S" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="wics__advanced" onClick={() => setAdvanced(true)}>
              Advanced…
            </button>
          </>
        )}
      </div>
    </details>
  );
}
