import { SetState } from "../live/model";
import { Connection } from "./Connection";

export function SetView({ state, lastSeen }: { state: SetState; lastSeen: number | null }) {
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
    </div>
  );
}
