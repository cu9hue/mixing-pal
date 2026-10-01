import "./Setup.css";
import { SetupStep } from "./step";
import {
  ConnectedScreen,
  ControlSurfaceScreen,
  ExperienceScreen,
  InstallScreen,
  OpenLiveScreen,
} from "./screens";
import { AccountState } from "../model/account";
import { ExperienceState } from "../model/experience";
import { AccountPanel } from "../ui/AccountPanel";

const TICK: Record<SetupStep, number> = {
  account: 0,
  install: 1,
  open_live: 2,
  control_surface: 3,
  connected: 3,
  experience: 4,
  done: 4,
};

export function Setup({
  account,
  experience,
  step,
  folder,
  trackCount,
  trackNames,
  onFactsChanged,
  onAcknowledgeConnected,
  onExit,
}: {
  account: AccountState;
  experience: ExperienceState;
  step: SetupStep;
  folder: string;
  trackCount: number;
  trackNames: string[];
  onFactsChanged: () => void;
  onAcknowledgeConnected: () => void;
  /** Present only when she opened setup from a banner rather than because
      first run is unfinished. Then this is her way back to the card. */
  onExit?: () => void;
}) {
  const here = TICK[step];

  return (
    <div className="setup" data-tauri-drag-region>
      <div className="setup__bar">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`setup__tick ${
              i < here ? "setup__tick--done" : i === here ? "setup__tick--here" : ""
            }`}
          />
        ))}
      </div>
      {/* "done" is deliberately absent: App finishes setup rather than
          rendering it, so this component never sees that step. */}
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
        {step === "experience" && <ExperienceScreen experience={experience} />}
        {step === "account" && (
          <>
            <div className="setup__label">Step 1 of 5</div>
            <AccountPanel account={account} />
          </>
        )}
      </div>
      {onExit !== undefined && (
        <div className="setup__footer">
          <button className="setup__secondary" onClick={onExit}>
            Back to Mixing Pal
          </button>
        </div>
      )}
    </div>
  );
}
