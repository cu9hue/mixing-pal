import { SupportContact } from "./ReportProblem";
import { useBusyState, beginMutation } from "../model/updates";
import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, AccountView, errorMessage } from "../model/account";
import { SharingConsent } from "./SharingConsent";
import { PlanPicker } from "./PlanPicker";
import "./AccountPanel.css";

function planLabel(view: AccountView): string {
  if (view.comp) return "Free access";
  if (!view.plan) return "Free pilot access";
  const name = view.plan === "pro" ? "Pro" : "Starter";
  return view.subscription_status === "trialing" ? `${name} · free trial` : name;
}

function dateWord(view: AccountView): string {
  if (!view.plan) return "until";
  if (view.subscription_status === "trialing") return "trial ends";
  return view.cancel_at_period_end ? "ends" : "resets";
}

export function AccountPanel({ account }: { account: AccountState }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const operations = useBusyState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletingShared, setDeletingShared] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // The confirmation opens below the fold of a scrolling panel; bring it to her, on Cancel.
  useEffect(() => {
    if (!deleting) return;
    keep.current?.scrollIntoView?.({ block: "nearest" });
    keep.current?.focus();
  }, [deleting]);
  const [sharedDeleted, setSharedDeleted] = useState(false);
  const [opened, setOpened] = useState(false);
  const view = account.view;
  const problem = error ?? account.error;
  const signingIn = view === null || view.access === "signed_out" || view.access === "invitation_required";

  async function act(action: () => Promise<void>) {
    if (!beginMutation(operations, "accountMutation")) return;
    setBusy(true);
    setError(null);
    try { await action(); } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); operations.accountMutation = false; }
  }

  function billing(action: "checkout" | "portal" | "start-now" | "upgrade", plan?: "starter" | "pro") {
    void act(async () => {
      const reply = await invoke<AccountView | { opened: true }>("account_billing", plan ? { action, plan } : { action });
      if ("opened" in reply) setOpened(true); else account.change(reply);
    });
  }

  if (view?.access === "development") return null;
  return (
    <section className={`account${signingIn ? " account--sign-in" : ""}`} aria-labelledby={`${id}-title`} data-tauri-drag-region="false">
      <h2 id={`${id}-title`} className="account__title">{signingIn ? "A mentor for the track you're writing." : "Account"}</h2>
      {signingIn && <p className="account__subtitle">Sign in with your email.</p>}
      {problem && <p id={`${id}-error`} className="account__error" role="alert">{problem}</p>}
      {view === null && <>
        <p>{problem ? "Your account could not be reached." : "Checking your account…"}</p>
        <button onClick={() => void account.refresh()}>Retry</button>
      </>}
      {view?.access === "signed_out" && <form className="account__sign-in-form" onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          if (!codeSent) {
            await invoke("account_send_code", { email: email.trim() });
            setCodeSent(true);
          } else {
            const next = await invoke<AccountView>("account_sign_in", { email: email.trim(), code });
            account.change(next);
            setCode("");
          }
        });
      }}>
        <label htmlFor={`${id}-email`}>Email</label>
        <input id={`${id}-email`} type="email" autoComplete="email" required value={email}
          placeholder="Enter your email"
          disabled={busy || operations.install || codeSent} onChange={(e) => setEmail(e.target.value)}
          aria-describedby={problem ? `${id}-error` : undefined} />
        {codeSent && <>
          <p>If this email can sign in, your code is on its way.</p>
          <label htmlFor={`${id}-code`}>Six-digit sign-in code</label>
          <input id={`${id}-code`} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}"
            maxLength={6} required value={code} autoFocus disabled={busy || operations.install} onChange={(e) => setCode(e.target.value)}
            aria-invalid={Boolean(error)} aria-describedby={problem ? `${id}-error` : undefined} />
        </>}
        <div className="account__actions">
          <button className="account__primary" type="submit" disabled={busy || operations.install}>{busy ? "Please wait…" : codeSent ? "Sign in" : "Continue"}</button>
          {codeSent && <button className="account__secondary" type="button" disabled={busy || operations.install} onClick={() => { setCodeSent(false); setCode(""); }}>Use another email or resend</button>}
        </div>
      </form>}
      {view?.access === "invitation_required" && <form onSubmit={(e) => {
        e.preventDefault();
        void act(async () => account.change(await invoke<AccountView>("account_redeem", { code: invite.trim() })));
      }}>
        <p>Signed in as {view.email}. Enter the invite code from your email.</p>
        <label htmlFor={`${id}-invite`}>Invitation code</label>
        <input id={`${id}-invite`} value={invite} required autoComplete="off" disabled={busy || operations.install}
          onChange={(e) => setInvite(e.target.value)} aria-describedby={problem ? `${id}-error` : undefined} />
        <button type="submit" disabled={busy || operations.install}>Join the free pilot</button>
      </form>}
      {view?.access === "plan_required" && <>
        <p>Signed in as {view.email}.</p>
        <PlanPicker trial={view.trial_available === true} busy={busy || operations.install} onPick={(plan) => billing("checkout", plan)} />
      </>}
      {opened && <p role="status">Finish in your browser. This window updates when you come back.</p>}
      {view?.access === "active" && <>
        <div className="account__summary">
          <div className="account__email">{view.email}</div>
          <div>{planLabel(view)}{(view.remaining_micro_usd ?? 0) > 0 ? "" : " · allowance used up"}
            {view.period_end && ` · ${dateWord(view)} ${new Date(view.period_end).toLocaleDateString()}`}</div>
          <div>${((view.remaining_micro_usd ?? 0) / 1_000_000).toFixed(2)} of model usage remains.
          {(view.reserved_micro_usd ?? 0) > 0 && " Some allowance is held for requests being checked."}</div>
          {view.can_ask === false && <div>{view.service_paused ? "Model access is temporarily paused." : (view.reserved_micro_usd ?? 0) > 0
            ? "We’re checking the last request’s usage before you can ask again."
            : <>
              The remaining allowance cannot cover another request.
              {view.plan && view.subscription_status === "active" && view.period_end && ` It resets on ${new Date(view.period_end).toLocaleDateString()}.`}
              {view.subscription_status === "trialing" && <div className="account__actions">
                <button className="account__primary" disabled={busy || operations.install} onClick={() => billing("start-now")}>Start my plan now</button>
                <span>Ends your trial and charges your card today.</span>
              </div>}
              {view.subscription_status === "active" && view.plan === "starter" && <div className="account__actions">
                <button className="account__primary" disabled={busy || operations.install} onClick={() => billing("upgrade")}>Upgrade to Pro</button>
                <span>Charges the difference for the rest of this period.</span>
              </div>}
            </>}</div>}
          {view.subscription_status === "past_due" && <p role="alert">Your payment didn't go through. Update your card to keep access
            {view.period_end && ` after ${new Date(view.period_end).toLocaleDateString()}`}.</p>}
        </div>
      </>}
      {view && ["active", "expired", "revoked"].includes(view.access) && <>
        <SharingConsent
          checked={view.capture}
          disabled={busy || operations.install || (view.access !== "active" && !view.capture)}
          onChange={(enabled) => {
            void act(async () => {
              account.change(await invoke<AccountView>("account_consent", { enabled }));
            });
          }}
        />
        {deletingShared ? <div>
          <p>Delete everything you shared? Your account, your sharing choice, and your conversations on this laptop stay.</p>
          <div className="account__actions">
            <button disabled={busy || operations.install} onClick={() => void act(async () => {
              await invoke("account_delete_shared"); setDeletingShared(false); setSharedDeleted(true);
            })}>Delete shared advice</button>
            <button disabled={busy || operations.install} onClick={() => setDeletingShared(false)}>Cancel</button>
          </div>
        </div> : <div>
          <button className="account__link" disabled={busy || operations.install} onClick={() => { setSharedDeleted(false); setDeletingShared(true); }}>Delete shared advice…</button>
        </div>}
        {sharedDeleted && <p role="status">Deletion requested.</p>}
      </>}
      {(view?.access === "expired" || view?.access === "revoked") && <p>Your pilot access has ended. Contact Mixing Pal to continue.</p>}
      {view && view.access !== "signed_out" && <div className="account__actions">
        {view.manage && <button disabled={busy || operations.install} onClick={() => billing("portal")}>Manage subscription</button>}
        <button disabled={busy || operations.install} onClick={() => void act(async () => {
          await invoke("account_sign_out"); account.change({ access: "signed_out", capture: false }); setCodeSent(false);
        })}>Sign out</button>
        <button disabled={busy || operations.install} onClick={() => setDeleting(true)}>Delete account…</button>
      </div>}
      {deleting && <div>
        <p>Delete your account? This can't be undone. Your access ends, and any subscription is canceled with no refund. Everything you shared is deleted. Your set notes stay on this laptop.</p>
        <div className="account__actions">
          <button className="account__danger" disabled={busy || operations.install} onClick={() => void act(async () => {
            await invoke("account_delete"); account.change({ access: "signed_out", capture: false }); setDeleting(false);
          })}>Delete my account</button>
          <button ref={keep} disabled={busy || operations.install} onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div>}
      {(signingIn || problem) && <SupportContact />}
    </section>
  );
}
