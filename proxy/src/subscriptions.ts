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
  ended_at: number | null;
  metadata: Record<string, string>;
  pending_update?: unknown;
  // Expanded by every read that is applied; a bare id means it was not.
  latest_invoice?: string | { id: string; status: string | null; amount_paid: number; billing_reason?: string | null;
    created?: number; status_transitions?: { paid_at: number | null }; hosted_invoice_url?: string | null } | null;
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
  checked_at: number;
}

export async function subscriptionRow(env: Env, memberId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ?").bind(memberId).first<SubscriptionRow>();
}

/**
 * Stamps a Stripe read when it starts: ms time in microseconds, plus a random part, so two
 * reads in the same ms share a stamp only 1 time in 1000. On a tie the loser's members writes
 * can land too; it then retries with a fresh read. Stored in subscriptions.synced_at only.
 */
export function readStamp(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// A members write in an apply's batch lands only when that apply's subscriptions write won.
// Binds: member id, read stamp, subscription id.
const WON = "EXISTS (SELECT 1 FROM subscriptions WHERE member_id = ? AND synced_at = ? AND stripe_subscription_id = ?)";

// A later period end is a new paid period, so the allowance is the plan's and spending starts again.
// The same end keeps both: an upgrade raises the allowance separately, prorated. reserved is never touched:
// requests in flight settle later. No new row while a deletion is pending: with no row yet, only the job records it.
function grant(env: Env, memberId: string, allowance: number, periodEnd: number, now: number, won: unknown[]) {
  return env.DB.prepare(`INSERT INTO members(id, allowance, period_end, created_at) SELECT ?, ?, ?, ? WHERE ${WON}
      AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL)
    ON CONFLICT(id) DO UPDATE SET
      allowance = CASE WHEN members.period_end < excluded.period_end THEN excluded.allowance ELSE members.allowance END,
      spent = CASE WHEN members.period_end < excluded.period_end THEN 0 ELSE members.spent END,
      period_end = MAX(members.period_end, excluded.period_end)
    WHERE members.comp = 0 AND members.deleted_at IS NULL`).bind(memberId, allowance, periodEnd, now, ...won, memberId);
}

interface InvoicePayment { payment: { type: string; payment_intent?: string | null; charge?: string | null } }

// Ends each idempotency key. Stripe replays a key's first result for a day, a 500 too: a retry in a later hour
// gets a fresh key, and two clicks in the same hour still share one.
const keyHour = () => Math.floor(Date.now() / 3_600_000);

// Refund errors that come back the same on every retry. Waiting on them would only keep the subscription charging.
const REFUSED = new Set(["stripe_rejected", "stripe_not_found", "card_declined"]);

/**
 * Refunds what a subscription that cannot be kept has charged, then cancels it.
 * Refund first: if the refund fails for now, the subscription is still there when the webhook retries.
 */
export async function cancelAndRefund(env: Env, sub: StripeSubscription,
  reason: "duplicate" | "orphan" | "comp" | "customer_mismatch" | "after_end"): Promise<void> {
  const invoice = sub.latest_invoice;
  const invoiceId = typeof invoice === "string" ? invoice : invoice?.id;
  // An expanded invoice that shows nothing paid saves the call; for a bare id, the list's status filter decides.
  const charged = typeof invoice === "string" || (invoice?.status === "paid" && invoice.amount_paid > 0);
  let refunded = false;
  if (invoiceId && charged) {
    // Since basil an invoice lists its payments as invoice_payments; it has no payment_intent of its own.
    const paid = await stripe<{ data: InvoicePayment[] }>(env, "GET", "/invoice_payments", { invoice: invoiceId, status: "paid" });
    for (const [i, { payment }] of paid.data.entries()) {
      const target = payment.type === "payment_intent" ? { payment_intent: payment.payment_intent }
        : payment.type === "charge" ? { charge: payment.charge } : null;
      if (!target) continue;
      try {
        // A second refund of the same payment, under a later hour's key, fails as already refunded.
        await stripe(env, "POST", "/refunds", target, `refund-${invoiceId}${i ? `-${i}` : ""}-${keyHour()}`);
        refunded = true;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.code === "stripe_already_refunded") refunded = true;
        else if (REFUSED.has(error.code)) {
          console.error(JSON.stringify({ event: "refund_failed", subscription: sub.id, reason, code: error.code }));
        } else throw error;
      }
    }
  }
  if (sub.status !== "canceled") await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`);
  console.error(JSON.stringify({ event: refunded ? "subscription_refunded" : "subscription_canceled_unrefunded", reason, subscription: sub.id }));
}

/**
 * Cancels a subscription of an account whose deletion is pending, and returns true; false when none is.
 * Deletion cancels with no refund, but a payment taken after the request bought access that never came.
 */
async function cancelForDeletionRequest(env: Env, sub: StripeSubscription, memberId: string): Promise<boolean> {
  const deletion = await env.DB.prepare(`SELECT COALESCE(
      (SELECT requested_at FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL),
      (SELECT deleted_at FROM members WHERE id = ?)) AS requested_at`).bind(memberId, memberId).first<{ requested_at: number | null }>();
  const requestedAt = deletion?.requested_at ?? null;
  if (requestedAt === null) return false;
  const invoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  // A renewal's invoice is created about an hour before it is charged: the time of payment decides.
  const paidAt = invoice?.status_transitions?.paid_at ?? invoice?.created ?? 0;
  if (invoice?.status === "paid" && paidAt * 1000 >= requestedAt) await cancelAndRefund(env, sub, "orphan");
  else {
    await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`);
    console.error(JSON.stringify({ event: "subscription_canceled_for_deletion", subscription: sub.id }));
  }
  return true;
}

/** A subscription with no row for its member and customer, after recreating the row was refused. */
async function unmatched(env: Env, sub: StripeSubscription, memberId: string): Promise<void> {
  const found = (await env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM "user" WHERE id = ?) AS user,
      EXISTS (SELECT 1 FROM members WHERE id = ? AND deleted_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL) AS deleting`)
    .bind(memberId, memberId, memberId).first<{ user: number; deleting: number }>())!;
  if (!found.user || found.deleting) {
    // No account will ever use it, so it must not charge.
    if (BILLABLE.has(sub.status)) await cancelAndRefund(env, sub, "orphan");
    else console.error(JSON.stringify({ event: "subscription_unknown", subscription: sub.id }));
    return;
  }
  // The member's row holds another customer, or this customer is another member's. The member keeps the row's customer.
  console.error(JSON.stringify({ event: "subscription_customer_mismatch", member_id: memberId, subscription: sub.id }));
  if (BILLABLE.has(sub.status)) await cancelAndRefund(env, sub, "customer_mismatch");
}

/**
 * Applies Stripe's current state. Callers pass a subscription just read from
 * Stripe, never an event payload: Stripe does not order events, and the same
 * state applied twice changes nothing. stamp is readStamp() taken when that
 * read started. The apply loses to a newer read already applied, and to a
 * change of the row's subscription since this call read it. It returns false
 * when it lost, so the caller reads Stripe again.
 */
export async function applySubscription(env: Env, sub: StripeSubscription, stamp: number, now = Date.now()): Promise<boolean> {
  const memberId = sub.metadata?.member_id;
  if (!memberId) {
    console.error(JSON.stringify({ event: "subscription_unknown", subscription: sub.id }));
    return true;
  }
  // Canceling leaves an open invoice payable on Stripe's page, so a payment can come after the end and buy nothing.
  // ended_at, not canceled_at: a cancel at period end sets canceled_at while the plan still runs.
  // The apply goes on, so the row still records the cancel.
  const last = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  if (sub.status === "canceled" && sub.ended_at !== null && last?.status === "paid" && last.amount_paid > 0
    && (last.status_transitions?.paid_at ?? last.created ?? 0) > sub.ended_at) await cancelAndRefund(env, sub, "after_end");
  const find = () => env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ? AND stripe_customer_id = ?")
    .bind(memberId, sub.customer).first<SubscriptionRow>();
  let row = await find();
  if (!row) {
    // Recreate a row lost to a restore or to the 90-day cleanup. One statement, so a deletion cannot land between check and insert.
    await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, updated_at) SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM members WHERE id = ? AND deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL)
      ON CONFLICT DO NOTHING`).bind(memberId, sub.customer, now, memberId, memberId, memberId).run();
    row = await find();
    if (!row) {
      await unmatched(env, sub, memberId);
      return true;
    }
  }
  // Comp means free. A subscription that slipped in through a Checkout opened before comp is a mistake.
  if (BILLABLE.has(sub.status) && (await member(env, memberId))?.comp) {
    await cancelAndRefund(env, sub, "comp");
    return true;
  }
  if (BILLABLE.has(sub.status) && await cancelForDeletionRequest(env, sub, memberId)) return true;
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
  const invoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  const paid = sub.status === "active" && invoice?.status === "paid";
  // The stored period moves only with a grant, so renewals() keeps re-reading a renewal that is not paid yet.
  const grants = sub.status === "trialing" || paid;
  const won = [memberId, stamp, sub.id];
  // A compare-and-swap on the read's stamp and on the subscription this call read from the row.
  // The stamp comes from this Worker's clock. Clocks on different Worker machines differ slightly; that is accepted.
  const writes = [env.DB.prepare(`UPDATE subscriptions SET stripe_subscription_id = ?, plan = ?, status = ?,
    current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?, trial_used = MAX(trial_used, ?),
    updated_at = ?, synced_at = ?
    WHERE member_id = ? AND synced_at < ? AND (stripe_subscription_id IS ? OR stripe_subscription_id = ?)`)
    .bind(sub.id, plan, sub.status, grants ? end : null, Number(sub.cancel_at_period_end), Number(sub.trial_end !== null), now, stamp,
      memberId, stamp, row.stripe_subscription_id, sub.id)];
  if (sub.status === "trialing") writes.push(grant(env, memberId, TRIAL_ALLOWANCE, (sub.trial_end ?? item.current_period_end) * 1000, now, won));
  else if (paid) {
    writes.push(grant(env, memberId, ALLOWANCE[plan], end, now, won));
    if (invoice?.billing_reason === "subscription_update") {
      // An upgrade adds the plan's extra over Starter only for the time left in the period, as Stripe prorates its price.
      // After a grant for a new period the allowance is already the full one, so MAX changes nothing.
      const upgradedAt = Math.min(Math.max((invoice.created ?? 0) * 1000, start), end);
      const prorated = Math.floor(ALLOWANCE.starter + (ALLOWANCE[plan] - ALLOWANCE.starter) * (end - upgradedAt) / (end - start));
      writes.push(env.DB.prepare(`UPDATE members SET allowance = MAX(allowance, ?) WHERE id = ? AND comp = 0 AND ${WON}`)
        .bind(prorated, memberId, ...won));
    }
  }
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
    const stamp = readStamp();
    if (await applySubscription(env, await stripe<StripeSubscription>(env, "GET", `/subscriptions/${encodeURIComponent(id)}`, EXPAND), stamp)) return;
  }
  throw new Error("subscription_apply_contended");
}

/**
 * Stripe keeps a deleted customer readable, marked deleted, so only that mark means gone. A customer it
 * cannot find at all points at the key (the other mode, another account), so it is not gone.
 */
async function customerGone(env: Env, id: string): Promise<boolean> {
  try {
    return (await stripe<{ deleted?: boolean }>(env, "GET", `/customers/${encodeURIComponent(id)}`)).deleted === true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "stripe_not_found") return false;
    throw error;
  }
}

/**
 * Asks Stripe for the customer's subscriptions, not the row, and applies each one that can still charge,
 * plus the row's own when its state differs from the row's. billable: one can still charge.
 * gone: Stripe marks the customer deleted. subscribed: the customer has held a subscription, of any status.
 */
async function syncCustomer(env: Env, row: SubscriptionRow): Promise<{ billable: boolean; gone: boolean; subscribed: boolean }> {
  const stamp = readStamp();
  const listed = await stripe<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions",
    { customer: row.stripe_customer_id, status: "all", limit: 10, expand: ["data.latest_invoice"] }).catch(async (error) => {
    if (!(error instanceof ApiError && error.code === "stripe_not_found")) throw error;
    if (!await customerGone(env, row.stripe_customer_id)) {
      // Stripe has no deleted mark for the customer, as with a wrong key: for the operator. A mark would end a paying row.
      console.error(JSON.stringify({ event: "stripe_customer_lookup_mismatch", member_id: row.member_id, customer: row.stripe_customer_id }));
      throw error;
    }
    // A customer Stripe marks deleted holds nothing that can charge, so the row stops showing a plan.
    // updated_at: renewals reads the row again for a day, in case the mark was wrong.
    await env.DB.prepare(`UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE member_id = ? AND stripe_customer_id = ?
      AND status IN (${[...BILLABLE].map(() => "?").join(", ")})`).bind(Date.now(), row.member_id, row.stripe_customer_id, ...BILLABLE).run();
    return null;
  });
  if (!listed) return { billable: false, gone: true, subscribed: false };
  let billable = false;
  for (const sub of listed.data) {
    if (BILLABLE.has(sub.status)) billable = true;
    // An ended subscription the row already shows needs no write; the write would keep the row in renewals' window.
    else if (sub.id !== row.stripe_subscription_id || sub.status === row.status) continue;
    // Applies after the first share the read's stamp and lose; the retry reads that one subscription again.
    if (!await applySubscription(env, sub, stamp)) await syncSubscription(env, sub.id);
  }
  return { billable, gone: false, subscribed: listed.data.length > 0 };
}

/** Expires the customer's open Checkout sessions, so none can start a subscription later. */
async function expireCheckouts(env: Env, customer: string): Promise<void> {
  const open = await stripe<{ data: { id: string }[] }>(env, "GET", "/checkout/sessions", { customer, status: "open", limit: 100 })
    .catch((error) => {
      // A customer Stripe no longer has has no sessions.
      if (error instanceof ApiError && error.code === "stripe_not_found") return { data: [] };
      throw error;
    });
  for (const { id } of open.data) await stripe(env, "POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`);
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

/** The member's Stripe customer, found by the member id its metadata holds. */
async function searchCustomer(env: Env, memberId: string): Promise<string | undefined> {
  const search = await stripe<{ data: { id: string }[] }>(env, "GET", "/customers/search",
    { query: `metadata['member_id']:'${memberId}'` });
  return search.data[0]?.id;
}

/** Stores the member's customer row and returns it. Only while the user exists: a deletion or the cleanup during the Stripe calls must not leave a row for nobody. */
async function storeCustomer(env: Env, memberId: string, customer: string): Promise<SubscriptionRow | null> {
  await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, updated_at) SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ?) ON CONFLICT(member_id) DO NOTHING`)
    .bind(memberId, customer, Date.now(), memberId).run();
  return subscriptionRow(env, memberId);
}

/**
 * The member's customer row, made now. found: the customer was already at Stripe, as after a database restore.
 * gone: the row's customer, which Stripe marks deleted; the row then takes the new one.
 */
async function customerFor(env: Env, memberId: string, gone?: string): Promise<{ row: SubscriptionRow; found: boolean }> {
  const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(memberId).first<{ email: string }>();
  if (!user) throw new ApiError(401, "sign_in_required", "Sign in again.");
  // Search can lag a deletion by about a minute.
  const searched = await searchCustomer(env, memberId);
  const found = searched === gone ? undefined : searched;
  // The key makes two quick clicks create one customer. A replacement has its own: Stripe would replay the deleted customer.
  const customer = found ?? (await stripe<{ id: string }>(env, "POST", "/customers", { email: user.email, metadata: { member_id: memberId } },
    `${gone ? `customer-${memberId}-${gone}` : `customer-${memberId}`}-${keyHour()}`)).id;
  // Only the row that still holds the gone customer: if another checkout replaced it first, the row keeps that one.
  if (gone) await env.DB.prepare("UPDATE subscriptions SET stripe_customer_id = ? WHERE member_id = ? AND stripe_customer_id = ?")
    .bind(customer, memberId, gone).run();
  const row = gone ? await subscriptionRow(env, memberId) : await storeCustomer(env, memberId, customer);
  if (!row) throw new ApiError(401, "sign_in_required", "Sign in again.");
  return { row, found: found !== undefined };
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
  const denied = () => new ApiError(403, "access_denied", "This account cannot subscribe.");
  if (m && (m.revoked || m.deleted_at)) throw denied();
  if (m?.comp) throw new ApiError(409, "comp_active", "Your account already has free access.");
  // The 90-day cleanup removes an untouched sign-up. Touch first, so it cannot remove this one while Stripe answers.
  const touched = await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = ?").bind(now, memberId).run();
  const existing = touched.meta.changes ? await subscriptionRow(env, memberId) : null;
  // Our cached status lags Stripe's webhook, so a second click would open a second Checkout. Stripe decides,
  // and what it has is applied now, so a member whose webhooks were lost gets access too.
  // An unpaid or paused one is asked about too: if Stripe has since ended it, the member can subscribe again.
  const synced = existing && !LIVE.has(existing.status) ? await syncCustomer(env, existing) : null;
  if (existing && (!synced || synced.billable)) return portalUrl(env, existing);
  // A pilot period still running would mix its spending into the plan's allowance.
  if (m && m.period_end > now) throw new ApiError(409, "access_active", "Your current access hasn't ended yet.");
  let row = existing;
  // A found customer that has held a subscription belongs to a member restored from a backup, who has had the trial.
  // One that has held none was made by an earlier try that failed before its row was stored.
  let subscribed = false;
  // Past the Portal, the row's customer has nothing billable. A deleted one can still list its subscriptions.
  if (!row || synced?.gone || await customerGone(env, row.stripe_customer_id)) {
    // A customer Stripe marks deleted cannot take a Checkout; Stripe canceled its subscriptions when it was deleted.
    const made = await customerFor(env, memberId, row?.stripe_customer_id);
    const listed = made.found ? await syncCustomer(env, made.row) : null;
    if (listed?.billable) return portalUrl(env, made.row);
    row = made.row;
    subscribed = listed?.subscribed ?? false;
  }
  // Sign-in refuses an account being deleted; this catches a deletion requested while Stripe answered.
  if (await env.DB.prepare("SELECT 1 FROM deletion_jobs WHERE member_id = ? AND completed_at IS NULL").bind(memberId).first()) throw denied();
  const trial = !m && !subscribed && row.trial_used !== 1;
  const session = await stripe<{ url: string }>(env, "POST", "/checkout/sessions", {
    mode: "subscription", customer: row.stripe_customer_id, client_reference_id: memberId,
    line_items: [{ price: priceFor(env, plan), quantity: 1 }],
    subscription_data: { metadata: { member_id: memberId },
      ...(trial ? { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } } : {}) },
    // Cards only, so a payment settles at once. Apple Pay and Google Pay are card payments.
    allowed_payment_method_types: ["card"],
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
  const stamp = readStamp();
  const started = await stripe<StripeSubscription>(env, "POST",
    `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`, { trial_end: "now", proration_behavior: "none", ...EXPAND });
  if (!await applySubscription(env, started, stamp)) await syncSubscription(env, started.id);
  // A declined card or a 3-D Secure check leaves the first invoice open: the member pays it on Stripe's page.
  const invoice = typeof started.latest_invoice === "object" ? started.latest_invoice : null;
  if (invoice && invoice.status !== "paid" && invoice.hosted_invoice_url) return json({ url: invoice.hosted_invoice_url });
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
  // Stripe moves the period about an hour before it charges. Until the renewal is paid, an upgrade's
  // paid proration would read as the new period being paid. Stripe can still move the period between this
  // read and the POST; that one round trip is an accepted risk, and a renewal that then fails gets past_due grace.
  if (current.items.data[0].current_period_end * 1000 > (row.current_period_end ?? 0)) {
    throw new ApiError(409, "renewal_pending", "Your renewal is still processing. Try again in an hour.");
  }
  const stamp = readStamp();
  // pending_if_incomplete: a declined card leaves Starter in place, with the change pending.
  const updated = await stripe<StripeSubscription>(env, "POST", path, {
    items: [{ id: current.items.data[0].id, price: priceFor(env, "pro") }],
    proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", ...EXPAND });
  if (!await applySubscription(env, updated, stamp)) await syncSubscription(env, updated.id);
  if (updated.pending_update) {
    // A declined card or a 3-D Secure check: paying the open invoice on Stripe's page applies the upgrade.
    const invoice = typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;
    if (invoice?.status === "open" && invoice.hosted_invoice_url) return json({ url: invoice.hosted_invoice_url });
    throw new ApiError(402, "card_declined", "Your card was declined. Update it in Manage subscription.");
  }
  return account(env, memberId, modern);
}

export async function comp(env: Env, email: string, now = Date.now()): Promise<{ member_id: string }> {
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE lower(email) = ?').bind(email).first<{ id: string }>();
  if (!user) throw new ApiError(404, "user_not_found", "No account uses that email. Ask them to sign in once first.");
  const row = await subscriptionRow(env, user.id);
  if (row && (await syncCustomer(env, row)).billable) {
    throw new ApiError(409, "subscription_live", "This account has a live subscription. Cancel it in Stripe first.");
  }
  const m = await member(env, user.id);
  if (m?.revoked || m?.deleted_at) throw new ApiError(409, "access_denied", "This account is revoked or deleted.");
  // A Checkout opened before comp would start a paid subscription; the apply path refunds any that slips through.
  if (row) await expireCheckouts(env, row.stripe_customer_id);
  await env.DB.prepare(`INSERT INTO members(id, allowance, period_end, created_at, comp) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET comp = 1, allowance = excluded.allowance,
      spent = CASE WHEN members.period_end <= ? THEN 0 ELSE members.spent END,
      period_end = MAX(members.period_end, excluded.period_end)`)
    .bind(user.id, COMP_ALLOWANCE, now + COMP_PERIOD, now, now).run();
  // A Checkout that completed after the first look is no longer open. Look again: the apply refunds and cancels it now that comp is set.
  if (row) await syncCustomer(env, row);
  return { member_id: user.id };
}

export async function uncomp(env: Env, memberId: string, now = Date.now()): Promise<void> {
  const result = await env.DB.prepare("UPDATE members SET comp = 0, period_end = MIN(period_end, ?) WHERE id = ? AND comp = 1")
    .bind(now, memberId).run();
  if (!result.meta.changes) throw new ApiError(404, "not_comped", "That account is not comped.");
}

export async function billingSync(env: Env, memberId: string): Promise<{ status: string }> {
  let row = await subscriptionRow(env, memberId);
  if (!row) {
    // A row lost to a database restore: find the customer Stripe has. Never make one here.
    const customer = await searchCustomer(env, memberId);
    if (!customer) return { status: "no_customer" };
    row = await storeCustomer(env, memberId, customer);
    // No account to store it for, as after a restore to before the sign-up. The subscription's next event refunds and cancels it.
    if (!row) return { status: "no_account" };
  }
  await syncCustomer(env, row);
  return { status: (await subscriptionRow(env, memberId))?.status ?? "none" };
}

/**
 * Comped periods roll every 30 days. Rows whose webhook may have been lost are read from Stripe,
 * each at most once an hour: a period an hour past its end, since the stored end moves only on payment,
 * and a row with no plan that can charge, touched in the last day, whose Checkout may have completed,
 * since a session lasts 24 hours.
 */
export async function renewals(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE members SET spent = 0, period_end = ? WHERE comp = 1 AND period_end <= ? AND revoked = 0 AND deleted_at IS NULL")
    .bind(now + COMP_PERIOD, now).run();
  if (!env.STRIPE_SECRET_KEY) return;
  const hour = 60 * 60_000;
  const billable = [...BILLABLE].map(() => "?").join(", ");
  const due = await env.DB.prepare(`SELECT * FROM subscriptions WHERE checked_at < ? AND (
      (status IN (${billable}) AND stripe_subscription_id IS NOT NULL AND COALESCE(current_period_end, 0) < ?)
      OR (status NOT IN (${billable}) AND updated_at > ?))
    ORDER BY checked_at LIMIT 20`)
    .bind(now - hour, ...BILLABLE, now - hour, ...BILLABLE, now - 26 * hour).all<SubscriptionRow>();
  for (const row of due.results) {
    // Claimed before the read, whatever its outcome, so a row Stripe keeps failing on waits its turn,
    // and an overlapping run skips it.
    const claimed = await env.DB.prepare("UPDATE subscriptions SET checked_at = ? WHERE member_id = ? AND checked_at < ?")
      .bind(now, row.member_id, now - hour).run();
    if (!claimed.meta.changes) continue;
    try { await syncCustomer(env, row); }
    catch { console.error(JSON.stringify({ event: "renewal_sync_failed", member_id: row.member_id, subscription: row.stripe_subscription_id })); }
  }
}

/**
 * Cancels every subscription that can still charge, at once, refunding only a payment taken after the request.
 * False means Stripe was unreachable and the deletion should wait.
 */
export async function cancelForDeletion(env: Env, memberId: string): Promise<boolean> {
  const row = await subscriptionRow(env, memberId);
  if (!row) return true;
  try {
    // First, so no Checkout still open can start a subscription after the list.
    await expireCheckouts(env, row.stripe_customer_id);
    // Ask Stripe, not the row: a Checkout or resubscribe whose webhook is late leaves the row stale.
    const listed = await stripe<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions",
      { customer: row.stripe_customer_id, status: "all", limit: 10, expand: ["data.latest_invoice"] }).catch((error) => {
      // A customer Stripe no longer has holds nothing that can renew.
      if (error instanceof ApiError && error.code === "stripe_not_found") return { data: [] };
      throw error;
    });
    for (const sub of listed.data) {
      // The sweep runs only for an open job. Without one, fail rather than skip the cancel.
      if (sub.status !== "canceled" && sub.status !== "incomplete_expired" && !await cancelForDeletionRequest(env, sub, memberId)) {
        throw new Error("deletion_not_pending");
      }
    }
    return true;
  } catch {
    console.error(JSON.stringify({ event: "deletion_cancel_failed", member_id: memberId }));
    return false;
  }
}
