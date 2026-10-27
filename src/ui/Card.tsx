import { useEffect, useState } from "react";
import { ReportProblem } from "./ReportProblem";
import { ReportTarget } from "../model/reports";
import { UpdateNotice } from "./UpdateNotice";
import { Updates } from "../model/updates";
import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { SetupStep } from "../setup/step";
import { Header } from "./Header";
import { Noticed } from "./Noticed";
import { Conversation } from "./Conversation";
import { Connection } from "./Connection";
import { Advanced } from "./Advanced";
import { AccountState } from "../model/account";
import { ExperienceState } from "../model/experience";
import { AccountPanel } from "./AccountPanel";

export function Card({
  account,
  experience,
  updates,
  onOpenSettings,
  visible = true,
  state,
  lastSeen,
  connected,
  nudge,
  onDismissNudge,
  onTurnRunningChange,
  onAnswer,
  onCollapse,
  onShowSetup,
  settingsOpen,
  onCloseSettings,
}: {
  account: AccountState;
  experience: ExperienceState;
  updates?: Updates;
  onOpenSettings?: () => void;
  visible?: boolean;
  state: SetState;
  lastSeen: number | null;
  connected: boolean;
  nudge: Nudge | null;
  onDismissNudge: (id: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onCollapse: () => void;
  onShowSetup: (step: SetupStep) => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
}) {
  const [report, setReport] = useState<(ReportTarget & { accountId: string; email: string }) | null>(null);
  const openReport = account.view?.id && account.view.email ? (target: ReportTarget) =>
    setReport({ ...target, accountId: account.view!.id!, email: account.view!.email! }) : undefined;
  useEffect(() => { setReport(null); }, [account.view?.id]);
  const activeReport = report?.accountId === account.view?.id ? report : null;
  // Until the member can use chat, the account panel holds the whole card:
  // signing in, picking a plan, fixing a payment, or reading that access was revoked.
  const needsAccount =
    account.view === null ||
    account.view.access === "signed_out" ||
    account.view.access === "invitation_required" ||
    account.view.access === "plan_required" ||
    account.view.access === "revoked";

  // One drag mechanism for the whole card: everything inside drags the
  // window, except buttons, inputs, and summaries (Tauri blocks those
  // itself), the answer and error text she may want to select, and the
  // scrollable body's own box, so the scrollbar thumb still scrolls. Each
  // exchange opts back in. See dragRegions.test.ts.
  return (
    <div className="card" data-tauri-drag-region="deep">
      <Header connected={connected} onCollapse={onCollapse} showConnection={!needsAccount} />
      {updates && onOpenSettings && <UpdateNotice view={updates.view}
        visible={visible && !settingsOpen && !needsAccount && !activeReport} onReview={onOpenSettings} />}
      {activeReport && <ReportProblem key={activeReport.accountId} target={activeReport} accountId={activeReport.accountId}
        email={activeReport.email} onClose={() => setReport(null)} />}
      {/* Settings replaces what is below the header, but hides it rather
          than unmounting it: the conversation and any answer in flight live
          in Conversation's state, the same reason App hides the card. */}
      {settingsOpen && (
        <div className="card__settings">
          <Advanced onReport={openReport} updates={updates} account={account} experience={experience} scriptVersion={state.scriptVersion} onClose={onCloseSettings} />
        </div>
      )}
      <div className={`card__main${settingsOpen ? " card__main--hidden" : ""}`}>
      {needsAccount && <div className="card__account card__account--solo"><AccountPanel account={account} /></div>}
      <div className={`card__session${needsAccount ? " card__session--hidden" : ""}`}>
      {!needsAccount && <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} onShowSetup={onShowSetup} />}
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
      {/* Preserve the conversation through brief Live interruptions. */}
      <div className={`card__conversation${connected ? "" : " card__conversation--hidden"}`}>
        <Conversation
          account={account}
          onReport={openReport}
          connected={connected}
          state={state}
          onTurnRunningChange={onTurnRunningChange}
          onAnswer={onAnswer}
        />
      </div>
      </div>
      </div>
    </div>
  );
}
