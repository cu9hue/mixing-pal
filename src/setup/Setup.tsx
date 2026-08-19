import "./Setup.css";
import { SetupFacts, SetupStep, currentStep } from "./step";
import {
  AccountScreen,
  ConnectedScreen,
  ControlSurfaceScreen,
  GoalScreen,
  InstallScreen,
  OpenLiveScreen,
} from "./screens";

/** Which of the four numbered ticks a step falls under. */
const TICK: Record<SetupStep, number> = {
  install: 0,
  open_live: 1,
  control_surface: 2,
  connected: 3,
  account: 3,
  goal: 3,
  done: 3,
};

export function Setup({
  facts,
  folder,
  trackCount,
  trackNames,
  goal,
  onGoalChange,
  onFactsChanged,
  onAcknowledgeConnected,
  onFinished,
}: {
  facts: SetupFacts;
  folder: string;
  trackCount: number;
  trackNames: string[];
  goal: string;
  onGoalChange: (value: string) => void;
  onFactsChanged: () => void;
  onAcknowledgeConnected: () => void;
  onFinished: () => void;
}) {
  const step = currentStep(facts);
  const here = TICK[step];

  return (
    <div className="setup" data-tauri-drag-region>
      <div className="setup__bar">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`setup__tick ${
              i < here ? "setup__tick--done" : i === here ? "setup__tick--here" : ""
            }`}
          />
        ))}
      </div>
      <div className="setup__main">
        {step === "install" && <InstallScreen folder={folder} onInstalled={onFactsChanged} />}
        {step === "open_live" && <OpenLiveScreen />}
        {step === "control_surface" && <ControlSurfaceScreen folder={folder} />}
        {step === "connected" && (
          <ConnectedScreen
            trackCount={trackCount}
            trackNames={trackNames}
            onContinue={onAcknowledgeConnected}
          />
        )}
        {step === "account" && <AccountScreen onContinue={onFinished} />}
        {step === "goal" && (
          <GoalScreen goal={goal} onGoalChange={onGoalChange} onFinish={onFinished} />
        )}
      </div>
      <div className="setup__footer" />
    </div>
  );
}
