import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import wireVersion from "../../shared/wire-version.json";

// Mirrors src-tauri/src/lib.rs's ConnectionStatus. A one-shot fetch is
// enough: the bind attempt happens once, at startup, before the window
// shows anything, and setup() deliberately does not retry-loop it (F3,
// 2026-08-16 whole-branch review) -- so this can never change mid-session.
export type ConnectionStatus =
  | { status: "bound" }
  | { status: "bind_failed"; port: number; error: string };

// How long traffic must be flowing with no version reply before the
// stale-script banner shows. There is a window right after connecting where
// deltas are already arriving but the first /live/copilot/get/version poll
// (every 5s, see PollKind::ScriptVersion) hasn't answered yet; without this
// grace period that window would render a confidently wrong "your script is
// out of date" diagnosis on every normal startup -- the same false-positive
// failure mode already fixed once for the port-conflict banner below.
//
// Must stay well above PollKind::ScriptVersion's 5s interval, not just
// past it: the first poll fires immediately on connect and normally replies
// in about a millisecond, but if that single reply is lost, the retry
// doesn't go out until the next 5s tick. A grace period of one interval
// plus a sliver of margin would then fire the banner at the same moment the
// retry lands -- a lost datagram, not a stale script, producing the exact
// wrong diagnosis this banner exists to avoid. Clearing two full intervals
// tolerates a lost poll and its retry before accusing the script. If
// PollKind::ScriptVersion's interval ever changes, this constant must be
// re-derived from it (at least ~2x, plus margin).
export const VERSION_GRACE_MS = 12_000;

// How long since the last delta before the connection counts as stale.
// Shared between selectBanner (the "not connected" case) and the caller,
// which uses the same threshold to decide when a fresh traffic run starts.
export const STALE_MS = 5000;

export type BannerState =
  | { kind: "none" }
  | { kind: "bind_failed"; port: number; error: string }
  | { kind: "not_connected" }
  | { kind: "version_mismatch"; required: number; actual: number }
  | { kind: "stale_script" };

// Pure decision function, kept separate from the component so it can be
// unit-tested without rendering: given a snapshot of everything the banner
// depends on, which one (if any) should show. Order matters -- earlier
// cases pre-empt later ones, e.g. a bind failure means no traffic could
// ever arrive, so it must win over "not connected" rather than the two
// fighting for the same render.
export function selectBanner(params: {
  now: number;
  connectionStatus: ConnectionStatus | null;
  lastSeen: number | null;
  scriptVersion: number | null;
  requiredVersion: number;
  trafficStartedAt: number | null;
}): BannerState {
  const { now, connectionStatus, lastSeen, scriptVersion, requiredVersion, trafficStartedAt } =
    params;

  // A port conflict means the socket never bound at all, so no traffic from
  // Live could ever arrive regardless of Control Surface setup -- telling
  // the producer to check that setting here would be a confidently wrong
  // diagnosis (the failure this codebase's own author hit and restarted
  // Live over, for nothing).
  if (connectionStatus?.status === "bind_failed") {
    return { kind: "bind_failed", port: connectionStatus.port, error: connectionStatus.error };
  }

  const stale = lastSeen === null || now - lastSeen > STALE_MS;
  if (stale) {
    return { kind: "not_connected" };
  }

  // Version received but doesn't match: most addresses still work under a
  // skew, so this warns rather than refusing to run -- but it names both
  // numbers so reinstalling is a specific, verifiable fix, not a guess.
  if (scriptVersion !== null && scriptVersion !== requiredVersion) {
    return { kind: "version_mismatch", required: requiredVersion, actual: scriptVersion };
  }

  // No version reply yet, but other traffic (faders, track state, ...) is
  // arriving -- this is the incident the handshake exists to catch: a
  // Remote Script old enough that it never registered the
  // /live/copilot/get/version handler at all, so decode_bulk's arity
  // mismatch silently drops every fader/pan/dB reading. Gated on
  // VERSION_GRACE_MS so the ordinary "first poll hasn't landed yet" window
  // right after connecting never triggers this.
  if (
    scriptVersion === null &&
    trafficStartedAt !== null &&
    now - trafficStartedAt > VERSION_GRACE_MS
  ) {
    return { kind: "stale_script" };
  }

  return { kind: "none" };
}

export function Connection({
  lastSeen,
  scriptVersion,
}: {
  lastSeen: number | null;
  scriptVersion: number | null;
}) {
  // This component only re-renders when SetView's state changes, which
  // happens when a delta arrives. But staleness is exactly the absence of
  // deltas — without this timer, the traffic that would trigger a re-render
  // never comes, so the banner would never appear no matter how long Live
  // has been disconnected. The interval forces a re-check every second.
  // Also drives the version-grace-period check in selectBanner, on the same
  // clock.
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

  const now = Date.now();
  const stale = lastSeen === null || now - lastSeen > STALE_MS;

  // Remembers when the current run of traffic began, so selectBanner can
  // require VERSION_GRACE_MS of it before showing the stale-script banner.
  // Resets whenever traffic actually stops (stale), so a disconnect/
  // reconnect (or a project reload that re-instantiates the Control
  // Surface) opens a fresh grace window rather than trusting a run that
  // ended long ago.
  const trafficStartedAt = useRef<number | null>(null);
  if (stale) {
    trafficStartedAt.current = null;
  } else if (trafficStartedAt.current === null) {
    trafficStartedAt.current = lastSeen;
  }

  const banner = selectBanner({
    now,
    connectionStatus,
    lastSeen,
    scriptVersion,
    requiredVersion: wireVersion.version,
    trafficStartedAt: trafficStartedAt.current,
  });

  switch (banner.kind) {
    case "none":
      return null;
    case "bind_failed":
      return (
        <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
          Can't reach Live: port {banner.port} is already in use by another
          process (a leftover script, or a second copy of this app). Close it
          and restart AbletonCopilot. ({banner.error})
        </div>
      );
    case "not_connected":
      return (
        <div style={{ background: "#7a2020", color: "white", padding: "6px 10px" }}>
          Not connected to Live. Open a set and choose <b>AbletonCopilot</b> under
          Preferences → Link/Tempo/MIDI → Control Surface.
        </div>
      );
    case "version_mismatch":
      return (
        <div style={{ background: "#7a5a20", color: "white", padding: "6px 10px" }}>
          Remote Script version mismatch: this app expects wire version{" "}
          {banner.required}, but the installed script reports version{" "}
          {banner.actual}. Reinstall the Remote Script and restart Live.
        </div>
      );
    case "stale_script":
      return (
        <div style={{ background: "#7a5a20", color: "white", padding: "6px 10px" }}>
          Receiving data from Live, but the Remote Script isn't reporting a
          version -- usually a sign it's out of date, and some data (faders,
          pan, dB readings) may be silently missing. Reinstall the Remote
          Script and restart Live.
        </div>
      );
  }
}
