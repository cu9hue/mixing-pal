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

function usageLabel(view: AccountView): string {
  if (view.subscription_status === "trialing") return "Trial usage";
  return view.plan || view.comp ? "Usage this month" : "Pilot usage";
}

// Usage shows as a share of the period, never as money. Rounded up, so it reads 0% only when nothing usable is left:
// a question holds a fixed reserve first, so a remainder below it reads 0%.
function shareLeft(view: AccountView): number {
  if (view.can_ask === false && !view.service_paused && !view.reserved_micro_usd) return 0;
  const allowance = view.allowance_micro_usd ?? 0;
  return Math.min(100, Math.ceil((view.remaining_micro_usd ?? 0) * 100 / allowance));
}

function dateWord(view: AccountView): string {
  if (view.comp) return "resets";
  if (!view.plan) return "until";
  if (view.subscription_status === "trialing") return "trial ends";
  if (view.subscription_status === "past_due") return "access until";
  return view.cancel_at_period_end ? "ends" : "resets";
}

/** `onboarding` is first-run setup, where deleting the account is not a step; Settings keeps it. */
export function AccountPanel({ account, onboarding = false }: { account: AccountState; onboarding?: boolean }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [resent, setResent] = useState(false);
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
  // Back from the browser with nothing changed yet: she finished and Stripe is still telling us, or she gave up.
  const [back, setBack] = useState(false);
  // Each trip to the browser restarts the polling window.
  const [trip, setTrip] = useState(0);
  const view = account.view;
  // The note is about a trip to the browser; once the account changes from the view the note first showed with, it is stale.
  // Not the view before the click: start-now and upgrade change the account, and that read can land in the note's first render.
  const shown = [view?.access, view?.plan, view?.subscription_status, view?.cancel_at_period_end, view?.comp, view?.period_end].join();
  const seen = useRef<{ trip: number; shown: string } | null>(null);
  useEffect(() => {
    if (!opened) seen.current = null;
    else if (seen.current?.trip !== trip) seen.current = { trip, shown };
    else if (seen.current.shown !== shown) setOpened(false);
  }, [opened, trip, shown]);
  // Checkout and invoice pages finish in the browser. Look again every 5 seconds for 2 minutes, then drop the note.
  useEffect(() => {
    if (!opened) return;
    const poll = setInterval(() => { void account.refresh(); }, 5_000);
    const stop = setTimeout(() => setOpened(false), 120_000);
    return () => { clearInterval(poll); clearTimeout(stop); };
  }, [opened, trip, account.refresh]);
  useEffect(() => {
    if (!opened) return;
    const onFocus = () => setBack(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [opened, trip]);
  const problem = error ?? account.error;
  // A member who ran out gets one way to more allowance, unless the service is paused or still checking usage.
  const wayUp = view?.access !== "active" || view.can_ask !== false || view.service_paused || (view.reserved_micro_usd ?? 0) > 0 ? null
    : view.subscription_status === "trialing" ? "start-now"
    : view.subscription_status === "active" && view.plan === "starter" ? "upgrade" : null;
  // Stripe still holds this subscription: they fix the card in the Portal. A new plan would be a second one.
  const unpaid = view?.subscription_status === "past_due" || view?.subscription_status === "unpaid";
  const signingIn = view === null || view.access === "signed_out" || view.access === "invitation_required";
  // With billing on anyone may sign up; otherwise only an invited email can. A failed read of which
  // it is reads as open: an invited user can still sign in, and a public one is not told to find an invite.
  const open = view?.signup !== "invite";

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
      if (!("opened" in reply)) { account.change(reply); return; }
      // Start-now and upgrade change the account before the invoice page opens. Read it first, so the note starts from that view.
      if (action === "start-now" || action === "upgrade") await account.refresh();
      setBack(false);
      setOpened(true);
      setTrip((n) => n + 1);
    });
  }

  if (view?.access === "development") return null;
  return (
    <section className={`account${signingIn ? " account--sign-in" : ""}`} aria-labelledby={`${id}-title`} data-tauri-drag-region="false">
      <h2 id={`${id}-title`} className="account__title">{signingIn ? "A mentor for the track you're writing."
        : view?.access === "plan_required" && !unpaid ? "Choose your plan" : "Account"}</h2>
      {view?.access === "revoked" && <div className="account__group"><p>Your access was revoked. Contact Mixing Pal.</p></div>}
      {signingIn && <p className="account__subtitle">{open ? "Sign in with your email." : "Sign in with the email your invite came to."}</p>}
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
            setResent(false);
          } else {
            const next = await invoke<AccountView>("account_sign_in", { email: email.trim(), code });
            account.change(next);
            setCode("");
          }
        });
      }}>
        <label htmlFor={`${id}-email`}>Email</label>
        <input id={`${id}-email`} type="email" autoComplete="email" required value={email}
          placeholder={open ? "Enter your email" : "Enter the email from your invitation"}
          disabled={busy || operations.install || codeSent} onChange={(e) => setEmail(e.target.value)}
          aria-describedby={problem ? `${id}-error` : undefined} />
        {codeSent && <>
          <p>{open ? `We sent a six-digit code to ${email.trim()}.` : "If your email has an invitation, your code is on its way."}</p>
          <p className="account__caption">It expires in 15 minutes. Not there? Check your spam folder.</p>
          <label htmlFor={`${id}-code`}>Six-digit sign-in code</label>
          <input id={`${id}-code`} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}"
            maxLength={6} required value={code} autoFocus disabled={busy || operations.install} onChange={(e) => setCode(e.target.value)}
            aria-invalid={Boolean(error)} aria-describedby={problem ? `${id}-error` : undefined} />
        </>}
        <div className="account__actions">
          <button className="account__primary" type="submit" disabled={busy || operations.install}>{busy ? "Please wait…" : codeSent ? "Sign in" : "Continue"}</button>
        </div>
        {codeSent && <div className="account__code-links">
          <button className="account__link" type="button" disabled={busy || operations.install} onClick={() => void act(async () => {
            await invoke("account_send_code", { email: email.trim() });
            setResent(true);
          })}>Resend code</button>
          <button className="account__link" type="button" disabled={busy || operations.install}
            onClick={() => { setCodeSent(false); setCode(""); setResent(false); }}>Use another email</button>
        </div>}
        {resent && <p role="status">Sent again.</p>}
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
        <div className="account__group"><p>Signed in as {view.email}.</p></div>
        <div className="account__group">
          {unpaid
            ? <p role="alert">Your payment didn't go through. Update your card in Manage subscription to get access back.</p>
            : <PlanPicker trial={view.trial_available === true} busy={busy || operations.install} onPick={(plan) => billing("checkout", plan)} />}
        </div>
      </>}
      {opened && <p role="status">{back ? "If you finished, this updates in a few seconds. If not, you can try again."
        : "Finish in your browser. This window updates when you come back."}</p>}
      {view?.access === "active" && <>
        <div className="account__group">
          <div className="account__summary">
            <div className="account__plan">{planLabel(view)}
              {view.period_end && ` · ${dateWord(view)} ${new Date(view.period_end).toLocaleDateString()}`}</div>
            <div className="account__email">{view.email}</div>
            {(view.allowance_micro_usd ?? 0) > 0 && <div className="account__usage">
              <div className="account__usage-line"><span id={`${id}-usage`}>{usageLabel(view)}</span><span>{shareLeft(view)}% left</span></div>
              <div className="account__meter" role="meter" aria-labelledby={`${id}-usage`} aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={shareLeft(view)} aria-valuetext={`${shareLeft(view)}% left`}>
                <div className="account__meter-fill" style={{ width: `${shareLeft(view)}%` }} />
              </div>
            </div>}
            {(view.reserved_micro_usd ?? 0) > 0 && <div>Some allowance is held for requests being checked.</div>}
            {view.can_ask === false && <div>{view.service_paused ? "Model access is paused on our side. Try again later." : (view.reserved_micro_usd ?? 0) > 0
              ? "We’re checking the last request’s usage before you can ask again."
              : "The remaining allowance cannot cover another request."}</div>}
          </div>
        </div>
        {(wayUp || view.subscription_status === "past_due") && <div className="account__group">
          {wayUp === "start-now" && <>
            <div className="account__actions">
              <button className="account__primary" disabled={busy || operations.install} onClick={() => billing("start-now")}>Start my plan now</button>
            </div>
            <p className="account__caption">Ends your trial and charges your card today.</p>
          </>}
          {wayUp === "upgrade" && <>
            <div className="account__actions">
              <button className="account__primary" disabled={busy || operations.install} onClick={() => billing("upgrade")}>Upgrade to Pro</button>
            </div>
            <p className="account__caption">Charges the difference for the rest of this period.</p>
          </>}
          {view.subscription_status === "past_due" && <p role="alert">Your payment didn't go through. Update your card to keep access
            {view.period_end && ` past ${new Date(view.period_end).toLocaleDateString()}`}.</p>}
        </div>}
      </>}
      {view && ["active", "expired", "revoked"].includes(view.access) && <div className="account__group">
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
      </div>}
      {/* Only billing off ends a period as expired. */}
      {view?.access === "expired" && <p>Your pilot access has ended. Contact Mixing Pal to continue.</p>}
      {view && view.access !== "signed_out" && <div className="account__group">
        <div className="account__actions">
          {view.manage && <button disabled={busy || operations.install} onClick={() => billing("portal")}>Manage subscription</button>}
          <button className="account__link" disabled={busy || operations.install} onClick={() => void act(async () => {
            await invoke("account_sign_out"); account.change({ access: "signed_out", capture: false }); void account.refresh(); setCodeSent(false);
          })}>Sign out</button>
          {!onboarding && <button className="account__link" disabled={busy || operations.install} onClick={() => setDeleting(true)}>Delete account…</button>}
        </div>
        {deleting && <div>
          <p>Delete your account? This can't be undone. Your access ends, and any subscription is canceled with no refund. Everything you shared is deleted. Your set notes stay on this laptop.</p>
          <div className="account__actions">
            <button className="account__danger" disabled={busy || operations.install} onClick={() => void act(async () => {
              await invoke("account_delete"); account.change({ access: "signed_out", capture: false }); void account.refresh(); setDeleting(false);
            })}>Delete my account</button>
            <button ref={keep} disabled={busy || operations.install} onClick={() => setDeleting(false)}>Cancel</button>
          </div>
        </div>}
      </div>}
      {(signingIn || problem) && <SupportContact />}
    </section>
  );
}
