const PLANS = [
  { key: "starter", name: "Starter", price: "$8 a month", detail: "For a few sessions a week" },
  { key: "pro", name: "Pro", price: "$20 a month", detail: "Four times Starter's usage" },
] as const;

export function PlanPicker({ trial, busy, onPick }: { trial: boolean; busy: boolean; onPick: (plan: "starter" | "pro") => void }) {
  return (
    <div className="plans">
      <p>{trial ? "Pick a plan. Both start with a 7-day free trial. Cancel before it ends and you pay nothing." : "Pick a plan to continue."}</p>
      <div className="plans__cards">
        {PLANS.map((plan) => (
          <div className="plans__card" key={plan.key}>
            <h3>{plan.name}</h3>
            <div className="plans__price">{plan.price}</div>
            <div>{plan.detail}</div>
            <button className="account__primary" disabled={busy} onClick={() => onPick(plan.key)}>
              {trial ? "Start 7-day free trial" : "Subscribe"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
