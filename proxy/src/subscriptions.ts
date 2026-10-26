import { z } from "zod";
import { ApiError, Env, json, readText } from "./env";
import { account, member } from "./account";
import { ALLOWANCE, BILLABLE, COMP_ALLOWANCE, COMP_PERIOD, LIVE, PAST_DUE_GRACE, Plan, TRIAL_ALLOWANCE, TRIAL_DAYS, planFor, priceFor } from "./plans";
import { stripe, verifySignature } from "./stripe";

/** The fields read from a subscription, as API version 2026-09-30.endive returns it. Times are seconds. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  metadata: Record<string, string>;
  pending_update?: unknown;
  // Expanded by every read that is applied; a bare id means it was not.
  latest_invoice?: string | { id: string; status: string | null; amount_paid: number } | null;
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
  synced_at: number;
}

export async function subscriptionRow(env: Env, memberId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ?").bind(memberId).first<SubscriptionRow>();
}

// A members write in an apply's batch lands only when that apply's subscriptions write won.
// Binds: member id, readAt, subscription id.
const WON = "EXISTS (SELECT 1 FROM subscriptions WHERE member_id = ? AND synced_at = ? AND stripe_subscription_id = ?)";

// A later period end is a new paid period, so spending starts again; the same
// end (an upgrade) keeps it. reserved is never touched: requests in flight settle later.
function grant(env: Env, memberId: string, allowance: number, periodEnd: number, now: number, won: unknown[]) {
  return env.DB.prepare(`INSERT INTO members(id, allowance, period_end, created_at) SELECT ?, ?, ?, ? WHERE ${WON}
    ON CONFLICT(id) DO UPDATE SET allowance = excluded.allowance,
      spent = CASE WHEN members.period_end < excluded.period_end THEN 0 ELSE members.spent END,
      period_end = MAX(members.period_end, excluded.period_end)
    WHERE members.comp = 0 AND members.deleted_at IS NULL`).bind(memberId, allowance, periodEnd, now, ...won);
}

interface InvoicePayment { payment: { type: string; payment_intent?: string | null; charge?: string | null } }

/**
 * Refunds what a subscription that cannot be kept has charged, then cancels it.
 * Refund first: if the refund fails, the subscription is still there when the webhook retries.
 */
export async function cancelAndRefund(env: Env, sub: StripeSubscription, reason: "duplicate" | "orphan" | "comp"): Promise<void> {
  const invoice = sub.latest_invoice;
  if (typeof invoice === "object" && invoice?.status === "paid" && invoice.amount_paid > 0) {
    // Since basil an invoice lists its payments as invoice_payments; it has no payment_intent of its own.
    const paid = await stripe<{ data: InvoicePayment[] }>(env, "GET", "/invoice_payments", { invoice: invoice.id, status: "paid" });
    for (const [i, { payment }] of paid.data.entries()) {
      const target = payment.type === "payment_intent" ? { payment_intent: payment.payment_intent }
        : payment.type === "charge" ? { charge: payment.charge } : null;
      if (!target) continue;
      await stripe(env, "POST", "/refunds", target, `refund-${invoice.id}${i ? `-${i}` : ""}`).catch((error) => {
        if (!(error instanceof ApiError && error.code === "stripe_already_refunded")) throw error;
      });
    }
  }
  if (sub.status !== "canceled") await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`);
  console.error(JSON.stringify({ event: "subscription_refunded", reason, subscription: sub.id }));
}

/**
 * For a subscription whose member has no row with its customer. True means the
 * row was recreated, after a restore or the 90-day cleanup lost it, and the apply goes on.
 */
async function recoverRow(env: Env, sub: StripeSubscription, memberId: string, now: number): Promise<boolean> {
  const found = (await env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM "user" WHERE id = ?) AS user,
      EXISTS (SELECT 1 FROM members WHERE id = ? AND deleted_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL) AS deleting,
      EXISTS (SELECT 1 FROM subscriptions WHERE member_id = ?) AS has_row`)
    .bind(memberId, memberId, memberId, memberId).first<{ user: number; deleting: number; has_row: number }>())!;
  if (!found.user || found.deleting) {
    // No account will ever use it, so it must not charge.
    if (BILLABLE.has(sub.status)) await cancelAndRefund(env, sub, "orphan");
    else console.error(JSON.stringify({ event: "subscription_unknown", subscription: sub.id }));
    return false;
  }
  if (found.has_row) {
    console.error(JSON.stringify({ event: "subscription_customer_mismatch", member_id: memberId, subscription: sub.id }));
    return false;
  }
  await env.DB.prepare("INSERT INTO subscriptions(member_id, stripe_customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(memberId, sub.customer, now).run();
  return true;
}

/**
 * Applies Stripe's current state. Callers pass a subscription just read from
 * Stripe, never an event payload: Stripe does not order events, and the same
 * state applied twice changes nothing. readAt is when that read started. The
 * apply loses to a newer read already applied, and to a change of the row's
 * subscription since this call read it. It returns false when it lost, so the
 * caller reads Stripe again.
 */
export async function applySubscription(env: Env, sub: StripeSubscription, readAt: number, now = Date.now()): Promise<boolean> {
  const memberId = sub.metadata?.member_id;
  const unknown = () => console.error(JSON.stringify({ event: "subscription_unknown", subscription: sub.id }));
  if (!memberId) {
    unknown();
    return true;
  }
  const find = () => env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ? AND stripe_customer_id = ?")
    .bind(memberId, sub.customer).first<SubscriptionRow>();
  let row = await find();
  if (!row) {
    if (!await recoverRow(env, sub, memberId, now)) return true;
    row = await find();
    // The insert met another member's row for this customer.
    if (!row) {
      unknown();
      return true;
    }
  }
  // Comp means free. A subscription that slipped in through a Checkout opened before comp is a mistake.
  if (BILLABLE.has(sub.status) && (await member(env, memberId))?.comp) {
    await cancelAndRefund(env, sub, "comp");
    return true;
  }
  if (row.stripe_subscription_id && row.stripe_subscription_id !== sub.id) {
    if (!LIVE.has(sub.status)) return true;
    // Read the stored one fresh: our cached status can lag a deletion webhook that has not arrived.
    const stored = await stripe<StripeSubscription>(env, "GET", `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`);
    if (LIVE.has(stored.status)) {
      // Two checkouts completed. Keep the first.
      await cancelAndRefund(env, sub, "duplicate");
      console.error(JSON.stringify({ event: "duplicate_subscription", member_id: memberId, subscription: sub.id }));
      return true;
    }
  }
  const item = sub.items.data[0];
  const plan = item ? planFor(env, item.price.id) : null;
  if (!item || !plan) {
    console.error(JSON.stringify({ event: "subscription_unknown_price", subscription: sub.id }));
    // A live one is paid for: fail, so the webhook and renewals retry once the price is configured.
    if (LIVE.has(sub.status)) throw new Error("subscription_unknown_price");
    return true;
  }
  const start = item.current_period_start * 1000;
  const end = item.current_period_end * 1000;
  const paid = sub.status === "active" && typeof sub.latest_invoice === "object" && sub.latest_invoice?.status === "paid";
  // The stored period moves only with a grant, so renewals() keeps re-reading a renewal that is not paid yet.
  const grants = sub.status === "trialing" || paid;
  const won = [memberId, readAt, sub.id];
  // A compare-and-swap on the read's start time and on the subscription this call read from the row.
  // readAt comes from this Worker's clock. Clocks on different Worker machines differ slightly; that is accepted.
  const writes = [env.DB.prepare(`UPDATE subscriptions SET stripe_subscription_id = ?, plan = ?, status = ?,
    current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?, trial_used = MAX(trial_used, ?),
    updated_at = ?, synced_at = ?
    WHERE member_id = ? AND synced_at < ? AND (stripe_subscription_id IS ? OR stripe_subscription_id = ?)`)
    .bind(sub.id, plan, sub.status, grants ? end : null, Number(sub.cancel_at_period_end), Number(sub.trial_end !== null), now, readAt,
      memberId, readAt, row.stripe_subscription_id, sub.id)];
  if (sub.status === "trialing") writes.push(grant(env, memberId, TRIAL_ALLOWANCE, (sub.trial_end ?? item.current_period_end) * 1000, now, won));
  else if (paid) writes.push(grant(env, memberId, ALLOWANCE[plan], end, now, won));
  else if (sub.status === "active" || sub.status === "past_due") {
    // Stripe moves the period about an hour before it charges, and ends a trial before the first charge:
    // until the invoice is paid, keep the old allowance and spending, as for a failed payment.
    writes.push(env.DB.prepare(`UPDATE members SET period_end = MAX(period_end, ?) WHERE id = ? AND comp = 0 AND ${WON}`)
      .bind(start + PAST_DUE_GRACE, memberId, ...won));
  } else if (sub.status !== "incomplete") {
    writes.push(env.DB.prepare(`UPDATE members SET period_end = MIN(period_end, ?) WHERE id = ? AND comp = 0 AND ${WON}`)
      .bind(now, memberId, ...won));
  }
  const [applied] = await env.DB.batch(writes);
  return applied.meta.changes > 0;
}

const EXPAND = { expand: ["latest_invoice"] };

/** Reads the subscription and applies it, again with a fresh read while a newer one keeps winning. */
export async function syncSubscription(env: Env, id: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const readAt = Date.now();
    if (await applySubscription(env, await stripe<StripeSubscription>(env, "GET", `/subscriptions/${encodeURIComponent(id)}`, EXPAND), readAt)) return;
  }
  throw new Error("subscription_apply_contended");
}

const event = z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.record(z.string(), z.unknown()) }) });

function rejected(reason: "not_configured" | "signature" | "unreadable"): void {
  console.error(JSON.stringify({ event: "stripe_webhook_rejected", reason }));
}

export async function stripeWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    rejected("not_configured");
    throw new ApiError(404, "not_found", "Not found.");
  }
  const body = await readText(request, 256 * 1024);
  if (!await verifySignature(env.STRIPE_WEBHOOK_SECRET, request.headers.get("Stripe-Signature"), body)) {
    rejected("signature");
    throw new ApiError(400, "invalid_signature", "The signature does not match.");
  }
  let parsed: z.infer<typeof event>;
  try { parsed = event.parse(JSON.parse(body)); }
  catch {
    rejected("unreadable");
    throw new ApiError(400, "invalid_request", "The event is unreadable.");
  }
  const object = parsed.data.object as { id?: unknown; subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } } | null };
  if (!parsed.type.startsWith("customer.subscription.") && parsed.type !== "invoice.paid") return json({ received: true });
  // Payloads take the endpoint's API version, not ours. Before basil an invoice named its subscription at the top level.
  const id = parsed.type === "invoice.paid" ? object.parent?.subscription_details?.subscription ?? object.subscription : object.id;
  if (typeof id !== "string") {
    console.error(JSON.stringify({ event: "stripe_event_unmatched", id: parsed.id, type: parsed.type }));
    return json({ received: true });
  }
  try { await syncSubscription(env, id); }
  catch (error) {
    console.error(JSON.stringify({ event: "stripe_event_failed", id: parsed.id, type: parsed.type }));
    throw error;
  }
  return json({ received: true });
}

const DONE: Record<string, string> = { canceled: "Checkout was canceled. Nothing was charged.", portal: "All set." };

export function billingDone(url: URL): Response {
  const heading = DONE[url.searchParams.get("state") ?? ""] ?? "You're in.";
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mixing Pal</title>
<body style="font:16px system-ui;margin:20vh auto;max-width:28rem;padding:0 1rem;text-align:center">
<h1 style="font-size:1.4rem">${heading}</h1><p>Go back to Mixing Pal.</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function requireBilling(env: Env): void {
  if (env.BILLING_ENABLED !== "true") throw new ApiError(404, "not_found", "Not found.");
}

async function customerFor(env: Env, memberId: string): Promise<SubscriptionRow> {
  const existing = await subscriptionRow(env, memberId);
  if (existing) return existing;
  const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(memberId).first<{ email: string }>();
  if (!user) throw new ApiError(401, "sign_in_required", "Sign in again.");
  // The key makes two quick clicks create one customer.
  const created = await stripe<{ id: string }>(env, "POST", "/customers",
    { email: user.email, metadata: { member_id: memberId } }, `customer-${memberId}`);
  await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(member_id) DO NOTHING`).bind(memberId, created.id, Date.now()).run();
  return (await subscriptionRow(env, memberId))!;
}

async function portalUrl(env: Env, row: SubscriptionRow): Promise<Response> {
  const session = await stripe<{ url: string }>(env, "POST", "/billing_portal/sessions",
    { customer: row.stripe_customer_id, return_url: `${env.API_ORIGIN}/billing/done?state=portal` });
  return json({ url: session.url });
}

export async function checkout(env: Env, memberId: string, input: unknown, now = Date.now()): Promise<Response> {
  requireBilling(env);
  const { plan } = z.object({ plan: z.enum(["starter", "pro"]) }).parse(input);
  const m = await member(env, memberId);
  if (m && (m.revoked || m.deleted_at)) throw new ApiError(403, "access_denied", "This account cannot subscribe.");
  if (m?.comp) throw new ApiError(409, "comp_active", "Your account already has free access.");
  const existing = await subscriptionRow(env, memberId);
  // Our cached status lags Stripe's webhook, so a second click would open a second Checkout. Stripe decides.
  if (existing && (LIVE.has(existing.status) || (await stripe<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions",
    { customer: existing.stripe_customer_id, status: "all", limit: 3 })).data.some((s) => LIVE.has(s.status)))) {
    return portalUrl(env, existing);
  }
  // A pilot period still running would mix its spending into the plan's allowance.
  if (m && m.period_end > now) throw new ApiError(409, "access_active", "Your current access hasn't ended yet.");
  const row = existing ?? await customerFor(env, memberId);
  // The 90-day cleanup removes an untouched sign-up; one in Checkout now must keep its customer.
  if (existing) await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = ?").bind(now, memberId).run();
  const trial = !m && row.trial_used !== 1;
  const session = await stripe<{ url: string }>(env, "POST", "/checkout/sessions", {
    mode: "subscription", customer: row.stripe_customer_id, client_reference_id: memberId,
    line_items: [{ price: priceFor(env, plan), quantity: 1 }],
    subscription_data: { metadata: { member_id: memberId },
      ...(trial ? { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } } : {}) },
    payment_method_collection: "always", automatic_tax: { enabled: true }, customer_update: { address: "auto" },
    success_url: `${env.API_ORIGIN}/billing/done`, cancel_url: `${env.API_ORIGIN}/billing/done?state=canceled`,
  });
  return json({ url: session.url });
}

// Not behind BILLING_ENABLED: after a rollback, subscribers still manage their plan.
export async function portal(env: Env, memberId: string): Promise<Response> {
  const row = await subscriptionRow(env, memberId);
  if (!row || row.status === "none") throw new ApiError(404, "no_subscription", "There's no subscription to manage yet.");
  return portalUrl(env, row);
}

export async function startNow(env: Env, memberId: string, modern: boolean): Promise<Response> {
  requireBilling(env);
  const row = await subscriptionRow(env, memberId);
  if (row?.status !== "trialing" || !row.stripe_subscription_id) throw new ApiError(409, "not_trialing", "Only a trial can start early.");
  const readAt = Date.now();
  const started = await stripe<StripeSubscription>(env, "POST",
    `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`, { trial_end: "now", proration_behavior: "none", ...EXPAND });
  if (!await applySubscription(env, started, readAt)) await syncSubscription(env, started.id);
  return account(env, memberId, modern);
}

export async function upgrade(env: Env, memberId: string, modern: boolean): Promise<Response> {
  requireBilling(env);
  const row = await subscriptionRow(env, memberId);
  if (row?.status !== "active" || row.plan !== "starter" || !row.stripe_subscription_id) {
    throw new ApiError(409, "not_upgradable", "Only an active Starter plan can upgrade.");
  }
  const path = `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`;
  const current = await stripe<StripeSubscription>(env, "GET", path);
  const readAt = Date.now();
  // pending_if_incomplete: a declined card leaves Starter in place, with the change pending.
  const updated = await stripe<StripeSubscription>(env, "POST", path, {
    items: [{ id: current.items.data[0].id, price: priceFor(env, "pro") }],
    proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", ...EXPAND });
  if (!await applySubscription(env, updated, readAt)) await syncSubscription(env, updated.id);
  if (updated.pending_update) throw new ApiError(402, "card_declined", "Your card was declined. Update it in Manage subscription.");
  return account(env, memberId, modern);
}

export async function comp(env: Env, email: string, now = Date.now()): Promise<{ member_id: string }> {
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE lower(email) = ?').bind(email).first<{ id: string }>();
  if (!user) throw new ApiError(404, "user_not_found", "No account uses that email. Ask them to sign in once first.");
  const row = await subscriptionRow(env, user.id);
  if (row && LIVE.has(row.status)) throw new ApiError(409, "subscription_live", "This account has a live subscription. Cancel it in Stripe first.");
  const m = await member(env, user.id);
  if (m?.revoked || m?.deleted_at) throw new ApiError(409, "access_denied", "This account is revoked or deleted.");
  await env.DB.prepare(`INSERT INTO members(id, allowance, period_end, created_at, comp) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET comp = 1, allowance = excluded.allowance,
      spent = CASE WHEN members.period_end <= ? THEN 0 ELSE members.spent END,
      period_end = MAX(members.period_end, excluded.period_end)`)
    .bind(user.id, COMP_ALLOWANCE, now + COMP_PERIOD, now, now).run();
  return { member_id: user.id };
}

export async function uncomp(env: Env, memberId: string, now = Date.now()): Promise<void> {
  const result = await env.DB.prepare("UPDATE members SET comp = 0, period_end = MIN(period_end, ?) WHERE id = ? AND comp = 1")
    .bind(now, memberId).run();
  if (!result.meta.changes) throw new ApiError(404, "not_comped", "That account is not comped.");
}

export async function billingSync(env: Env, memberId: string): Promise<{ status: string }> {
  const row = await subscriptionRow(env, memberId);
  if (row?.stripe_subscription_id) await syncSubscription(env, row.stripe_subscription_id);
  return { status: (await subscriptionRow(env, memberId))?.status ?? "none" };
}

/** Comped periods roll every 30 days; subscriptions whose renewal webhook is an hour late are re-read. */
export async function renewals(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE members SET spent = 0, period_end = ? WHERE comp = 1 AND period_end <= ? AND revoked = 0 AND deleted_at IS NULL")
    .bind(now + COMP_PERIOD, now).run();
  if (!env.STRIPE_SECRET_KEY) return;
  const due = await env.DB.prepare(`SELECT stripe_subscription_id AS id FROM subscriptions
    WHERE status IN ('trialing', 'active', 'past_due') AND stripe_subscription_id IS NOT NULL AND current_period_end < ?
    ORDER BY current_period_end DESC LIMIT 20`)
    .bind(now - 60 * 60_000).all<{ id: string }>();
  for (const { id } of due.results) {
    try { await syncSubscription(env, id); }
    catch { console.error(JSON.stringify({ event: "renewal_sync_failed", subscription: id })); }
  }
}

/** Cancels every live subscription at once with no refund. False means Stripe was unreachable and the deletion should wait. */
export async function cancelForDeletion(env: Env, memberId: string): Promise<boolean> {
  const row = await subscriptionRow(env, memberId);
  if (!row) return true;
  try {
    // Ask Stripe, not the row: a Checkout or resubscribe whose webhook is late leaves the row stale.
    const listed = await stripe<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions",
      { customer: row.stripe_customer_id, status: "all", limit: 10 }).catch((error) => {
      // A customer Stripe no longer has holds nothing that can renew.
      if (error instanceof ApiError && error.code === "stripe_not_found") return { data: [] };
      throw error;
    });
    for (const sub of listed.data) {
      if (LIVE.has(sub.status)) await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`);
    }
    return true;
  } catch {
    console.error(JSON.stringify({ event: "deletion_cancel_failed", member_id: memberId }));
    return false;
  }
}
