import "./Pill.css";
import { PillState } from "./pillState";

/**
 * The collapsed window. `data-tauri-drag-region` on the body makes the
 * whole pill a drag handle -- there is no titlebar, so without it she has
 * no way to move the window at all.
 */
export function Pill({ state, onClick }: { state: PillState; onClick: () => void }) {
  return (
    <div className={`pill pill--${state}`}>
      <div
        className="pill__body"
        data-tauri-drag-region
        onClick={onClick}
        title={state === "disconnected" ? "Not connected to Live" : "Mixing Pal"}
      >
        <span className="pill__dot" />
      </div>
    </div>
  );
}
