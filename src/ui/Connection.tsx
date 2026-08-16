import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/lib.rs's ConnectionStatus. A one-shot fetch is
// enough: the bind attempt happens once, at startup, before the window
// shows anything, and setup() deliberately does not retry-loop it (F3,
// 2026-08-16 whole-branch review) -- so this can never change mid-session.
export type ConnectionStatus =
  | { status: "bound" }
  | { status: "bind_failed"; port: number; error: string };

export function Connection({ lastSeen }: { lastSeen: number | null }) {
  // This component only re-renders when SetView's state changes, which
  // happens when a delta arrives. But staleness is exactly the absence of
  // deltas — without this timer, the traffic that would trigger a re-render
  // never comes, so the banner would never appear no matter how long Live
  // has been disconnected. The interval forces a re-check every second.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  useEffect(() => {
    invoke<ConnectionStatus>("connection_status")
      .then(setConnectionStatus)
      .catch((err) => console.error("failed to fetch connection status", err));
  }, []);

  // A port conflict means the socket never bound at all, so no traffic from
  // Live could ever arrive regardless of Control Surface setup -- telling
  // the producer to check that setting here would be a confidently wrong
  // diagnosis (the failure this codebase's own author hit and restarted
  // Live over, for nothing).
  if (connectionStatus?.status === "bind_failed") {
    return (
      <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
        Can't reach Live: port {connectionStatus.port} is already in use by
        another process (a leftover script, or a second copy of this app).
        Close it and restart AbletonCopilot. ({connectionStatus.error})
      </div>
    );
  }

  const stale = lastSeen === null || Date.now() - lastSeen > 5000;
  if (!stale) return null;
  return (
    <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
      Not connected to Live. Open a set and choose <b>AbletonCopilot</b> under
      Preferences → Link/Tempo/MIDI → Control Surface.
    </div>
  );
}
