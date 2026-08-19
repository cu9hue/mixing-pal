import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Delta } from "./live/model";
import { emptySet, applyDelta } from "./live/apply";
import { Card } from "./ui/Card";
import { Pill } from "./ui/Pill";
import { pillState } from "./ui/pillState";
import { MODE_GEOMETRY, ModeEvent, WindowMode, nextMode } from "./ui/windowMode";
import { STALE_MS } from "./ui/Connection";
import { unnamedTracks } from "./rules/unnamedTracks";
import { EMPTY_NUDGE_STATE, dismiss, offer } from "./rules/nudges";
import wireVersion from "../shared/wire-version.json";
import { Setup } from "./setup/Setup";
import { SetupFacts, currentStep } from "./setup/step";
import { loadGoal, saveGoal } from "./ui/goal";

export default function App() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [mode, setMode] = useState<WindowMode>("card");
  const [nudges, setNudges] = useState(EMPTY_NUDGE_STATE);
  const [turnRunning, setTurnRunning] = useState(false);
  const [unread, setUnread] = useState(false);
  const [inputEmpty, setInputEmpty] = useState(true);

  // The mode machine needs the current context on every event, but the
  // context changes far more often than the mode does. A ref keeps the
  // dispatch callback stable so it does not re-subscribe the blur listener
  // on every keystroke.
  const ctx = useRef({ inputEmpty, turnRunning, unread });
  ctx.current = { inputEmpty, turnRunning, unread };

  const dispatch = useCallback((event: ModeEvent) => {
    setMode((current) => nextMode(current, event, ctx.current));
  }, []);

  useEffect(() => {
    // Rust never resends a subscription's initial value on its own -- it
    // arrives once, at subscribe time, and the emit loop can drain and
    // forward it before this listener even exists. Attach the listener
    // FIRST, then fetch the retained snapshot: nothing can slip through
    // the gap, because applyDelta is last-write-wins, so a delta that
    // arrives mid-fetch and also appears in the snapshot just gets applied
    // twice, harmlessly. Fetching first would risk the opposite.
    const stop = listen<Delta[]>("live://deltas", (event) => {
      setState((prev) => event.payload.reduce(applyDelta, prev));
      setLastSeen(Date.now());
    });

    invoke<Delta[]>("snapshot")
      .then((snapshot) => {
        if (snapshot.length === 0) return;
        setState((prev) => snapshot.reduce(applyDelta, prev));
        setLastSeen(Date.now());
      })
      .catch((err) => {
        console.error("failed to fetch initial snapshot", err);
      });

    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  // Staleness is the absence of deltas, so no delta will ever arrive to
  // trigger the re-render that notices it. This forces the check.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const connected = lastSeen !== null && Date.now() - lastSeen <= STALE_MS;

  const [goal, setGoal] = useState(loadGoal);
  const [folder, setFolder] = useState("");
  const [connectorInstalled, setConnectorInstalled] = useState<boolean | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [connectedAcknowledged, setConnectedAcknowledged] = useState(false);
  const [goalAnswered, setGoalAnswered] = useState(() => loadGoal().trim() !== "");

  const refreshConnector = useCallback(() => {
    invoke<{ folder: string; installed: boolean }>("connector_status")
      .then((s) => {
        setFolder(s.folder);
        setConnectorInstalled(s.installed);
      })
      .catch((err) => console.error("failed to read connector status", err));
  }, []);

  useEffect(refreshConnector, [refreshConnector]);

  // Polled only while setup is on screen. Once she is past it there is
  // nothing to decide, and a process scan every two seconds forever is a
  // cost with no buyer.
  useEffect(() => {
    if (mode !== "setup") return;
    const poll = () => {
      invoke<boolean>("live_is_running").then(setLiveRunning).catch(() => setLiveRunning(false));
      refreshConnector();
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [mode, refreshConnector]);

  const facts: SetupFacts = {
    connectorInstalled: connectorInstalled ?? true,
    // A version mismatch means the app updated and the part inside Live
    // did not, and reinstalling is the fix -- the same fix as a missing
    // connector, so it is the same step.
    connectorCurrent: state.scriptVersion === null || state.scriptVersion === wireVersion.version,
    liveRunning,
    deltasArriving: connected,
    connectedAcknowledged,
    hasAccount: true, // the model-access plan replaces this
    goalAnswered,
  };

  // connector_status has not answered yet on the very first render.
  // Guessing "not installed" would flash the setup window at someone whose
  // setup has been finished for months.
  const setupNeeded = connectorInstalled !== null && currentStep(facts) !== "done";

  useEffect(() => {
    if (setupNeeded) setMode("setup");
    else dispatch({ type: "setup_finished" });
  }, [setupNeeded, dispatch]);

  // Rules run against every state change; `offer` is what stops a true
  // observation reappearing every two seconds.
  useEffect(() => {
    setNudges((n) => offer(n, unnamedTracks(state), Date.now()));
  }, [state]);

  const nudge = nudges.current;
  useEffect(() => {
    if (nudge !== null) dispatch({ type: "nudge_arrived" });
  }, [nudge, dispatch]);

  useEffect(() => {
    const onBlur = () => dispatch({ type: "blur" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "escape" });
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
    };
  }, [dispatch]);

  // Resize after the DOM has the new content but before the frame paints,
  // so the window never shows a card at the pill's size or the reverse.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const geometry = MODE_GEOMETRY[mode];
    const height =
      geometry.height ??
      Math.min(root.current?.scrollHeight ?? 0, geometry.maxHeight ?? Infinity);
    invoke("set_window_mode", { mode, width: geometry.width, height: Math.ceil(height) }).catch(
      (err) => console.error("failed to apply window mode", err),
    );
  });

  const trackNames = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => state.tracks[i].name ?? "");

  return (
    <div ref={root}>
      {mode === "setup" && setupNeeded ? (
        <Setup
          facts={facts}
          folder={folder}
          trackCount={trackNames.length}
          trackNames={trackNames}
          goal={goal}
          onGoalChange={(v) => {
            setGoal(v);
            saveGoal(v);
          }}
          onFactsChanged={refreshConnector}
          onAcknowledgeConnected={() => setConnectedAcknowledged(true)}
          onFinished={() => {
            setGoalAnswered(true);
            dispatch({ type: "setup_finished" });
          }}
        />
      ) : mode === "card" ? (
        <Card
          state={state}
          lastSeen={lastSeen}
          connected={connected}
          nudge={nudge}
          goal={goal}
          onGoalChange={(v) => {
            setGoal(v);
            saveGoal(v);
          }}
          onDismissNudge={(id) => setNudges((n) => dismiss(n, id))}
          onTurnRunningChange={setTurnRunning}
          onAnswer={() => {
            setUnread(true);
            dispatch({ type: "answer_completed" });
          }}
          onCollapse={() => dispatch({ type: "chevron_closed" })}
          onInputEmptyChange={setInputEmpty}
          onShowSetup={() => setMode("setup")}
        />
      ) : (
        <Pill
          state={pillState({ connected, unread, turnRunning })}
          onClick={() => {
            setUnread(false);
            dispatch({ type: "pill_clicked" });
          }}
        />
      )}
    </div>
  );
}
