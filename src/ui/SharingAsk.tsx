import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, AccountView, errorMessage } from "../model/account";
import { beginMutation, useBusyState } from "../model/updates";
import "./OutcomeRow.css";
import "./SharingAsk.css";

/**
 * Whether to ask about sharing. Only a member with access can store consent, and the
 * question waits for the first rated move, when the producer has seen an answer work.
 * A server that does not report the choice never triggers it.
 */
export function asksToShare(view: AccountView | null, rated: boolean): boolean {
  return rated && view?.access === "active" && view.sharing_chosen === false;
}

/** Asked once, in the footer where the check-in was. Either answer records the choice; Settings changes it. */
export function SharingAsk({ account }: { account: AccountState }) {
  const operations = useBusyState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(enabled: boolean) {
    if (!beginMutation(operations, "accountMutation")) return;
    setBusy(true);
    setError(null);
    try {
      account.change(await invoke<AccountView>("account_consent", { enabled }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      operations.accountMutation = false;
    }
  }

  return <section className="sharing-ask outcome" aria-label="Help me get better at this?" data-tauri-drag-region="false">
    <div className="outcome__question">Help me get better at this?</div>
    <p className="sharing-ask__body">
      If you share, a person on our team reads your questions, what I read in your set, my answers and what you tell me about them.
      We delete them after 30 days and never use them to train AI. You can change this in Settings.
    </p>
    <div className="outcome__choices">
      <button type="button" className="outcome__choice" disabled={busy} onClick={() => void choose(true)}>Share</button>
      <button type="button" className="outcome__choice" disabled={busy} onClick={() => void choose(false)}>No thanks</button>
    </div>
    {error !== null && <p className="outcome__status" role="status">{error}</p>}
  </section>;
}
