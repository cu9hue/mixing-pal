import { useId, useState } from "react";

const PLANS = [
  { key: "starter", name: "Starter", price: "$8 a month", detail: "For a few sessions a week" },
  { key: "pro", name: "Pro", price: "$20 a month", detail: "Four times Starter's usage" },
] as const;

export function PlanPicker({ trial, busy, onPick }: { trial: boolean; busy: boolean; onPick: (plan: "starter" | "pro") => void }) {
  const name = useId();
  const [plan, setPlan] = useState<"starter" | "pro">("starter");
  return (
    <div className="plans">
      <fieldset className="plans__choice">
        <legend>{trial ? "Pick a plan. Both start with a 7-day free trial. Cancel before it ends and you pay nothing." : "Pick a plan to continue."}</legend>
        {PLANS.map((p) => (
          <label className="plans__row" key={p.key}>
            <input type="radio" name={name} value={p.key} checked={plan === p.key} onChange={() => setPlan(p.key)} />
            <span className="plans__name">{p.name}</span>
            <span className="plans__price">{p.price}</span>
            <span className="plans__detail">{p.detail}</span>
          </label>
        ))}
      </fieldset>
      <div className="account__actions">
        <button className="account__primary" disabled={busy} onClick={() => onPick(plan)}>
          {trial ? "Start 7-day free trial" : "Subscribe"}
        </button>
      </div>
    </div>
  );
}
