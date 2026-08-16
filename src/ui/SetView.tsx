import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Delta } from "../live/model";
import { emptySet, applyDelta } from "../live/apply";
import { Connection } from "./Connection";

export function SetView() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);

  useEffect(() => {
    // Rust never resends a subscription's initial value on its own — it
    // arrives once, at subscribe time, and the emit loop can drain and
    // forward it before this listener even exists. Attach the listener
    // FIRST, then fetch the retained snapshot: nothing can slip through
    // the gap between the two, because applyDelta is last-write-wins, so a
    // delta that arrives mid-fetch and also appears in the snapshot just
    // gets applied twice, harmlessly. Fetching first would risk the
    // opposite — a value changing between the snapshot response and the
    // listener attaching would never be seen at all.
    const stop = listen<Delta[]>("live://deltas", (event) => {
      setState((prev) => event.payload.reduce(applyDelta, prev));
      setLastSeen(Date.now());
    });

    invoke<Delta[]>("snapshot")
      .then((snapshot) => {
        if (snapshot.length === 0) return;
        setState((prev) => snapshot.reduce(applyDelta, prev));
        // A non-empty snapshot means the app is (or recently was) connected;
        // clear the "not connected" banner immediately instead of waiting
        // for the next change to produce a delta.
        setLastSeen(Date.now());
      })
      .catch((err) => {
        // A rejected invoke would otherwise become an unhandled promise
        // rejection; the live deltas listener above still works on its
        // own, so this is a missed catch-up, not a fatal error.
        console.error("failed to fetch initial snapshot", err);
      });

    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div style={{ font: "13px ui-monospace, monospace", padding: 10 }}>
      <Connection lastSeen={lastSeen} />
      <div style={{ marginBottom: 8 }}>
        {state.tempo ?? "—"} BPM · {state.scaleName ?? "no scale"} ·{" "}
        {state.isPlaying ? "playing" : "stopped"}
      </div>
      <table>
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
    </div>
  );
}
