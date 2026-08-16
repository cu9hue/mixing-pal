import { useEffect, useState } from "react";

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

  const stale = lastSeen === null || Date.now() - lastSeen > 5000;
  if (!stale) return null;
  return (
    <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
      Not connected to Live. Open a set and choose <b>AbletonCopilot</b> under
      Preferences → Link/Tempo/MIDI → Control Surface.
    </div>
  );
}
