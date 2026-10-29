import { useId, useState } from "react";
import { TermsAgreement } from "./TermsAgreement";

const PLANS = [
  { key: "starter", name: "Starter", price: "$8 a month", detail: "For a few sessions a week" },
  { key: "pro", name: "Pro", price: "$20 a month", detail: "Four times Starter's usage" },
] as const;

/** `terms` asks for agreement to the Terms first, for an account that signed in before it was asked or since they changed. */
export function PlanPicker({ trial, terms = false, busy, onPick }:
  { trial: boolean; terms?: boolean; busy: boolean; onPick: (plan: "starter" | "pro") => void }) {
  const name = useId();
  const [plan, setPlan] = useState<"starter" | "pro">("starter");
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="plans">
      <fieldset className="plans__choice">
        <legend>{trial ? "Pick a plan. Both start with a 7-day free trial." : "Pick a plan. It starts today."}</legend>
        {PLANS.map((p) => (
          <label className="plans__row" key={p.key}>
            <input type="radio" name={name} value={p.key} checked={plan === p.key} onChange={() => setPlan(p.key)} />
            <span className="plans__name">{p.name}</span>
            <span className="plans__price">{p.price}</span>
            <span className="plans__detail">{p.detail}</span>
          </label>
        ))}
      </fieldset>
      {/* Checkout asks for a card next; saying so here keeps "free" from reading as a trick. */}
      <p className="account__caption">{trial
        ? "You add a card now. Nothing is charged until the trial ends, and you can cancel before then. "
          + "The trial includes the same usage on either plan. Prices exclude tax where it applies."
        : "Your card is charged when you subscribe. Cancel any time. Prices exclude tax where it applies."}</p>
      {terms && <TermsAgreement checked={agreed} disabled={busy} onChange={setAgreed} />}
      <div className="account__actions">
        <button className="account__primary" disabled={busy || (terms && !agreed)} onClick={() => onPick(plan)}>
          {trial ? "Start 7-day free trial" : "Subscribe"}
        </button>
      </div>
    </div>
  );
}
