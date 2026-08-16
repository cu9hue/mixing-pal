import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Delta } from "../live/model";
import { emptySet, applyDelta } from "../live/apply";
import { Connection } from "./Connection";

export function SetView() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);

  useEffect(() => {
    const stop = listen<Delta[]>("live://deltas", (event) => {
      setState((prev) => event.payload.reduce(applyDelta, prev));
      setLastSeen(Date.now());
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
              <td>{state.tracks[i].volumeDb ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
