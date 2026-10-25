import { Env } from "./env";
import { ALLOWANCE, LIVE, PAST_DUE_GRACE, Plan, TRIAL_ALLOWANCE, planFor } from "./plans";
import { stripe } from "./stripe";

/** The fields read from a subscription, as API version 2026-09-30.endive returns it. Times are seconds. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  metadata: Record<string, string>;
  pending_update?: unknown;
  items: { data: { id: string; price: { id: string }; current_period_start: number; current_period_end: number }[] };
}

export interface SubscriptionRow {
  member_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  plan: Plan | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  trial_used: number;
  updated_at: number;
}

export async function subscriptionRow(env: Env, memberId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ?").bind(memberId).first<SubscriptionRow>();
}

// A later period end is a new paid period, so spending starts again; the same
// end (an upgrade) keeps it. reserved is never touched: requests in flight settle later.
function grant(env: Env, memberId: string, allowance: number, periodEnd: number, now: number) {
  return env.DB.prepare(`INSERT INTO members(id, allowance, period_end, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET allowance = excluded.allowance,
      spent = CASE WHEN members.period_end < excluded.period_end THEN 0 ELSE members.spent END,
      period_end = MAX(members.period_end, excluded.period_end)
    WHERE members.comp = 0 AND members.deleted_at IS NULL`).bind(memberId, allowance, periodEnd, now);
}

/**
 * Applies Stripe's current state. Callers pass a subscription just read from
 * Stripe, never an event payload: Stripe does not order events, and the same
 * state applied twice changes nothing.
 */
export async function applySubscription(env: Env, sub: StripeSubscription, now = Date.now()): Promise<void> {
  const memberId = sub.metadata?.member_id;
  const row = memberId ? await env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ? AND stripe_customer_id = ?")
    .bind(memberId, sub.customer).first<SubscriptionRow>() : null;
  if (!memberId || !row) {
    console.error(JSON.stringify({ event: "subscription_unknown", subscription: sub.id }));
    return;
  }
  if (row.stripe_subscription_id && row.stripe_subscription_id !== sub.id) {
    if (!LIVE.has(sub.status)) return;
    // Read the stored one fresh: our cached status can lag a deletion webhook that has not arrived.
    const stored = await stripe<StripeSubscription>(env, "GET", `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`);
    if (LIVE.has(stored.status)) {
      // Two checkouts completed. Keep the first; refunding the second is the operator's call.
      await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`);
      console.error(JSON.stringify({ event: "duplicate_subscription", member_id: memberId, subscription: sub.id }));
      return;
    }
  }
  const item = sub.items.data[0];
  const plan = item ? planFor(env, item.price.id) : null;
  if (!item || !plan) {
    console.error(JSON.stringify({ event: "subscription_unknown_price", subscription: sub.id }));
    return;
  }
  const start = item.current_period_start * 1000;
  const end = item.current_period_end * 1000;
  const writes = [env.DB.prepare(`UPDATE subscriptions SET stripe_subscription_id = ?, plan = ?, status = ?, current_period_end = ?,
    cancel_at_period_end = ?, trial_used = MAX(trial_used, ?), updated_at = ? WHERE member_id = ?`)
    .bind(sub.id, plan, sub.status, end, Number(sub.cancel_at_period_end), Number(sub.trial_end !== null), now, memberId)];
  if (sub.status === "trialing") writes.push(grant(env, memberId, TRIAL_ALLOWANCE, (sub.trial_end ?? item.current_period_end) * 1000, now));
  else if (sub.status === "active") writes.push(grant(env, memberId, ALLOWANCE[plan], end, now));
  else if (sub.status === "past_due") {
    writes.push(env.DB.prepare("UPDATE members SET period_end = ? WHERE id = ? AND comp = 0").bind(start + PAST_DUE_GRACE, memberId));
  } else if (sub.status !== "incomplete") {
    writes.push(env.DB.prepare("UPDATE members SET period_end = MIN(period_end, ?) WHERE id = ? AND comp = 0").bind(now, memberId));
  }
  await env.DB.batch(writes);
}

export async function syncSubscription(env: Env, id: string): Promise<void> {
  await applySubscription(env, await stripe<StripeSubscription>(env, "GET", `/subscriptions/${encodeURIComponent(id)}`));
}
