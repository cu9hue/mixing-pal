import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Delta } from "./live/model";
import { emptySet, applyDelta } from "./live/apply";
import { Card } from "./ui/Card";
import { Pill } from "./ui/Pill";
import { pillState } from "./ui/pillState";
import { CARD_MAX_HEIGHT, MODE_GEOMETRY, ModeEvent, WindowMode, nextMode, geometryApply, Measured } from "./ui/windowMode";
import { STALE_MS } from "./ui/Connection";
import { unnamedTracks } from "./rules/unnamedTracks";
import { EMPTY_NUDGE_STATE, dismiss, offer } from "./rules/nudges";
import wireVersion from "../shared/wire-version.json";
import { Setup } from "./setup/Setup";
import { SetupFacts, SetupStep, currentStep, needsSetup } from "./setup/step";
import { loadSetupDone, saveSetupDone } from "./setup/setupDone";
import { loadGoal, saveGoal } from "./ui/goal";

export default function App() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [mode, setMode] = useState<WindowMode>("card");
  const [nudges, setNudges] = useState(EMPTY_NUDGE_STATE);
  const [turnRunning, setTurnRunning] = useState(false);
  const [unread, setUnread] = useState(false);
  // Settings… from the app menu. The pane replaces the card's content and
  // opens the card if she picked it from the pill.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;

  const dispatch = useCallback((event: ModeEvent) => {
    setMode((current) => nextMode(current, event));
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
  const [setupDone, setSetupDone] = useState(loadSetupDone);
  // Set only when she asks for a setup screen from a banner. The window
  // then opens on that screen whatever the derivation thinks, and clearing
  // it is the only way out -- so every path that sets it has one.
  const [forcedStep, setForcedStep] = useState<SetupStep | null>(null);

  const refreshConnector = useCallback(() => {
    invoke<{ folder: string; installed: boolean }>("connector_status")
      .then((s) => {
        setFolder(s.folder);
        setConnectorInstalled(s.installed);
      })
      .catch((err) => console.error("failed to read connector status", err));
  }, []);

  useEffect(refreshConnector, [refreshConnector]);

  // A version mismatch means the app updated and the part inside Live did
  // not, and reinstalling is the fix -- the same fix as a missing
  // connector, so it is the same step.
  const connectorCurrent =
    state.scriptVersion === null || state.scriptVersion === wireVersion.version;

  const facts: SetupFacts = {
    connectorInstalled: connectorInstalled ?? true,
    connectorCurrent,
    liveRunning,
    deltasArriving: connected,
    connectedAcknowledged,
    hasAccount: true, // the model-access plan replaces this
    goalAnswered,
  };

  const setupNeeded = needsSetup({ connectorInstalled, connectorCurrent, setupDone });
  const setupOpen = setupNeeded || forcedStep !== null;
  const step = forcedStep ?? currentStep(facts);

  // What is actually on screen. `mode` is the state machine's answer and
  // setup is not one of its events, so the two are reconciled here rather
  // than by a render guard that can fail both ways -- which is how a
  // forced setup used to leave the app rendering a pill into a 44px window
  // with no way out.
  const view: WindowMode = setupOpen ? "setup" : mode === "setup" ? "card" : mode;
  const setupOpenRef = useRef(setupOpen);
  setupOpenRef.current = setupOpen;

  const finishSetup = useCallback(() => {
    setGoalAnswered(true);
    // Persisted, unlike the step. See setupDone.ts: this is a fact about
    // the world, not a cursor, and Skip leaves nothing else behind.
    setSetupDone(true);
    saveSetupDone(true);
    setForcedStep(null);
    dispatch({ type: "setup_finished" });
  }, [dispatch]);

  useEffect(() => {
    if (setupOpen) setMode("setup");
    else dispatch({ type: "setup_finished" });
  }, [setupOpen, dispatch]);

  // Setup has no "done" screen. Someone upgrading into this build carries
  // a goal but no setupDone flag, so she can satisfy the last step by
  // acknowledging the connected screen and leave nothing to show. Record
  // the flag and hand over to the card rather than render an empty window.
  useEffect(() => {
    if (setupNeeded && forcedStep === null && step === "done") finishSetup();
  }, [setupNeeded, forcedStep, step, finishSetup]);

  // Polled only while setup is on screen. Once she is past it there is
  // nothing to decide, and a process scan every two seconds forever is a
  // cost with no buyer.
  useEffect(() => {
    if (!setupOpen) return;
    const poll = () => {
      invoke<boolean>("live_is_running").then(setLiveRunning).catch(() => setLiveRunning(false));
      refreshConnector();
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [setupOpen, refreshConnector]);

  // She opened the Control Surface step from the "not connected" banner.
  // Traffic arriving is exactly the thing she went there to fix, so the
  // screen has done its job and the card comes back on its own.
  useEffect(() => {
    if (forcedStep === "control_surface" && connected) setForcedStep(null);
  }, [forcedStep, connected]);

  // Rules run against every state change; `offer` is what stops a true
  // observation reappearing every two seconds.
  useEffect(() => {
    setNudges((n) => offer(n, unnamedTracks(state), Date.now()));
  }, [state]);

  const nudge = nudges.current;
  // A nudge never opens the card: it is unprompted, and taking the screen
  // from someone mid-take is the most intrusive thing this app could do. It
  // announces itself with the pill's glow instead, which means it MUST set
  // unread -- without this a nudge arriving while the card is shut is
  // completely silent until she happens to open it.
  //
  // viewRef rather than a `view` dependency: this must fire when a nudge
  // arrives, not every time the view changes while one is still on screen.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (nudge !== null && viewRef.current !== "card") setUnread(true);
  }, [nudge]);

  // Nothing is unread while she is looking at it. Without this the first
  // answer left `unread` true forever, and the blur rule -- which requires
  // !unread -- never collapsed the card again.
  useEffect(() => {
    if (view === "card" && !settingsOpen) setUnread(false);
  }, [view, settingsOpen]);

  useEffect(() => {
    const stop = listen("menu://settings", () => {
      // Setup owns the window until it finishes; a pane queued behind it
      // would pop up the moment she gets past the last step.
      if (setupOpenRef.current) return;
      setSettingsOpen(true);
      dispatch({ type: "settings_opened" });
    });
    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // One step back at a time: Escape leaves Settings before it leaves
      // the card.
      if (settingsOpenRef.current) setSettingsOpen(false);
      else dispatch({ type: "escape" });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [dispatch]);

  // The card's ceiling is one number, owned by MODE_GEOMETRY and published
  // to CSS here. Card.css used to say 100vh, which clamped the card to the
  // window before it could be measured -- so the window could only shrink,
  // and a card reopened from the pill measured 44 and stayed 44.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--card-max-height", `${CARD_MAX_HEIGHT}px`);
  }, []);

  // Measured after every render, because the content can change without
  // any state this component owns changing. setState re-renders only when
  // the number actually moved, which is what keeps the effect below quiet.
  const root = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  useLayoutEffect(() => {
    const geometry = MODE_GEOMETRY[view];
    const height = Math.ceil(
      geometry.height ??
        Math.min(root.current?.scrollHeight ?? 0, geometry.maxHeight ?? Infinity),
    );
    // The height travels with the mode it was measured for, so the effect
    // below can tell a fresh measurement from the outgoing mode's. Returning
    // the same object when nothing moved is what keeps this from looping.
    setMeasured((prev) =>
      prev !== null && prev.view === view && prev.height === height ? prev : { view, height },
    );
  });

  // Resize before the frame paints, so the window never shows a card at
  // the pill's size or the reverse.
  //
  // The dependencies are load-bearing. The 1s staleness tick re-renders
  // this component for the life of the process; an unconditional apply
  // called set_window_mode on every one of those ticks, which re-centred
  // the setup window a second after she dragged it and enumerated her
  // monitors once a second forever.
  const centredFor = useRef<WindowMode | null>(null);
  useLayoutEffect(() => {
    // Returns null while `measured` still describes the mode we just left --
    // applying it there resized the incoming window to the outgoing
    // content, one visibly wrong frame per transition. See geometryApply.
    const apply = geometryApply(view, measured, centredFor.current);
    if (apply === null) return;
    centredFor.current = view;
    invoke("set_window_mode", apply).catch((err) =>
      console.error("failed to apply window mode", err),
    );
  }, [view, measured]);

  const trackNames = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => state.tracks[i].name ?? "");

  return (
    <div ref={root}>
      {view === "setup" && (
        <Setup
          step={step}
          folder={folder}
          trackCount={trackNames.length}
          trackNames={trackNames}
          goal={goal}
          onGoalChange={(v) => {
            setGoal(v);
            saveGoal(v);
          }}
          onFactsChanged={() => {
            refreshConnector();
            // She came here from a banner to reinstall. The install is
            // done, so the force is spent -- otherwise this screen would
            // be the only thing she could ever see again.
            setForcedStep(null);
          }}
          onAcknowledgeConnected={() => setConnectedAcknowledged(true)}
          onFinished={finishSetup}
          onExit={forcedStep !== null ? () => setForcedStep(null) : undefined}
        />
      )}
      {/* Mounted whether or not it is showing. The conversation lives in
          here: the thread she reads and the history the model is sent both
          survive a collapse to the pill only if the component does. */}
      <div className={view === "card" ? undefined : "card-slot--hidden"}>
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
            // Unread only if she was not watching it arrive. The card is not
            // reopened either way -- see nextMode's pill_clicked comment.
            if (view !== "card") setUnread(true);
          }}
          onCollapse={() => dispatch({ type: "chevron_closed" })}
          onShowSetup={setForcedStep}
          settingsOpen={settingsOpen}
          onCloseSettings={() => setSettingsOpen(false)}
        />
      </div>
      {view === "pill" && (
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
