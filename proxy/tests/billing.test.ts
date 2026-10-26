import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { deleteAccount } from "../src/capture";
import { DAY, Env } from "../src/env";
import { maintain } from "../src/maintenance";
import { StripeSubscription, applySubscription, cancelAndRefund, cancelForDeletion, readStamp, renewals, syncSubscription } from "../src/subscriptions";
import { StripeCall, StripeRoutes, missing, paramsOf, sign, stubNetwork, subscription } from "./stripe-fixtures";

const on = { ...env, BILLING_ENABLED: "true" } as unknown as Env;
const S = 1000;
let routes: StripeRoutes;
let calls: StripeCall[];
let otp: string;

async function api(path: string, body?: unknown, token?: string, opts: { method?: string; modern?: boolean; ip?: string; env?: Env } = {}) {
  const method = opts.method ?? (body === undefined ? "GET" : "POST");
  return worker.fetch(new Request(`http://localhost:8787${path}`, { method,
    headers: { "Content-Type": "application/json", "cf-connecting-ip": opts.ip ?? "127.0.0.1",
      ...(opts.modern === false ? {} : { "Mixing-Pal-Version": "0.3.0" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), (opts.env ?? on) as never, createExecutionContext());
}

async function signedIn(email = "producer@example.com") {
  expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
  const signed = await api("/auth/sign-in/email-otp", { email, otp });
  expect(signed.status, await signed.clone().text()).toBe(200);
  return { token: signed.headers.get("set-auth-token")!, id: ((await signed.json()) as { user: { id: string } }).user.id };
}

// Each test-side read stamp is newer than the one before it, and older than any stamp the code under test takes.
let reads = 0;
const read = () => (Date.now() - 60_000) * 1000 + ++reads;
const apply = (sub: StripeSubscription, now?: number) => applySubscription(on, sub, read(), now);

async function customer(memberId = "m1", customerId = "cus_1") {
  await env.DB.prepare("INSERT INTO subscriptions(member_id, stripe_customer_id, updated_at) VALUES (?, ?, 0)").bind(memberId, customerId).run();
}

async function memberRow(id = "m1") {
  return env.DB.prepare("SELECT allowance, spent, reserved, period_end, comp FROM members WHERE id = ?").bind(id)
    .first<{ allowance: number; spent: number; reserved: number; period_end: number; comp: number }>();
}

async function subRow(id = "m1") {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE member_id = ?").bind(id).first<Record<string, unknown>>();
}

async function user(id: string) {
  await env.DB.prepare(`INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, '', ?, 1, '2026-01-01', '2026-01-01')`)
    .bind(id, `${id}@example.com`).run();
}

/** Each paid invoice has one card payment, pi_<invoice id>, and refunds succeed. */
function paidInvoices() {
  routes["GET /invoice_payments"] = (params) => ({ data: [{ id: `inpay_${params.get("invoice")}`, status: "paid",
    payment: { type: "payment_intent", payment_intent: `pi_${params.get("invoice")}` } }] });
  routes["POST /refunds"] = (params) => ({ id: `re_${params.get("payment_intent")}`, status: "succeeded" });
}

const events = (logged: { mock: { calls: unknown[][] } }) => logged.mock.calls.map(([line]) => JSON.parse(String(line)));
// Idempotency keys end with the hour, which can turn during a call: the keys a call started at `from` can send.
const hourKeys = (prefix: string, from: number) => [0, 1].map((n) => `${prefix}-${Math.floor(from / 3_600_000) + n}`);

/** An env whose D1 batch waits at a gate: it holds one apply between its reads and its write, as a slow Worker would. */
function gated() {
  let reached!: () => void;
  let open!: () => void;
  const atBatch = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const DB = { prepare: (sql: string) => env.DB.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => { reached(); await gate; return env.DB.batch(statements); } };
  return { env: { ...on, DB } as unknown as Env, atBatch, open };
}

beforeEach(async () => {
  routes = {};
  calls = [];
  otp = "";
  stubNetwork(routes, calls, (text) => { const match = text.match(/code is (\d{6})/); if (match) otp = match[1]; });
  await env.DB.batch(["subscriptions", "deletion_jobs", "consents", "members", "session", "account", "user", "verification",
    "rateLimit", "api_limits", "operator_actions", "sign_in_sends", "invites"].map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
});
afterEach(() => vi.restoreAllMocks());

describe("applying Stripe state", () => {
  const now = Date.now();
  const t = Math.floor(now / 1000);

  test("a trial grants $1 until the trial ends and marks the trial used", async () => {
    await customer();
    await apply(subscription({ status: "trialing", member: "m1", trial_end: t + 7 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 1_000_000, spent: 0, period_end: (t + 7 * 86_400) * S });
    expect(await subRow()).toMatchObject({ status: "trialing", plan: "starter", trial_used: 1, stripe_subscription_id: "sub_1" });
  });

  test("the first paid period after a trial gives the tier's allowance and starts spending again", async () => {
    await customer();
    await apply(subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    await env.DB.prepare("UPDATE members SET spent = 900000 WHERE id = 'm1'").run();
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start: t, end: t + 30 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, spent: 0, period_end: (t + 30 * 86_400) * S });
  });

  // A paid upgrade halfway through a Starter period: Stripe invoices the proration at once.
  const start = t - 15 * 86_400;
  const end = t + 15 * 86_400;
  const upgraded = () => subscription({ status: "active", member: "m1", price: "price_pro", start, end,
    latest_invoice: { id: "in_2", billing_reason: "subscription_update", created: t } });

  test("an upgrade at the period's midpoint adds half of Pro's extra allowance, keeps what she spent, and a replay changes nothing", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", start, end }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    await apply(upgraded(), now);
    expect(await memberRow()).toMatchObject({ allowance: 5_000_000, spent: 1_500_000, period_end: end * S });
    await env.DB.prepare("UPDATE members SET spent = 1600000 WHERE id = 'm1'").run();
    await apply(upgraded(), now);
    expect(await memberRow()).toMatchObject({ allowance: 5_000_000, spent: 1_600_000, period_end: end * S });
  });

  test("a plain paid read in the same period does not raise the allowance", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", start, end }), now);
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start, end }), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("the paid renewal after an upgrade grants Pro's full allowance", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", start, end }), now);
    await apply(upgraded(), now);
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start: end, end: end + 30 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, spent: 0, period_end: (end + 30 * 86_400) * S });
  });

  test("a trial started early gets the plan's full allowance, though its first invoice is an update", async () => {
    await customer();
    await apply(subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 3 * 86_400 }), now);
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start: t, end: t + 30 * 86_400,
      latest_invoice: { billing_reason: "subscription_update", created: t } }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, period_end: (t + 30 * 86_400) * S });
  });

  test("a renewal starts spending again, and the same state applied twice changes nothing more", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const renewed = subscription({ status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 });
    await apply(renewed, now);
    await env.DB.prepare("UPDATE members SET spent = 400000 WHERE id = 'm1'").run();
    await apply(renewed, now);
    expect(await memberRow()).toMatchObject({ spent: 400_000, period_end: (t + 31 * 86_400) * S });
  });

  test("a renewal keeps money held for requests in flight", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000, reserved = 310000 WHERE id = 'm1'").run();
    await apply(subscription({ status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ spent: 0, reserved: 310_000 });
  });

  test("a renewal whose invoice is not paid yet keeps spending and the allowance, with seven days of access", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const renewal = { status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 };
    await apply(subscription({ ...renewal, latest_invoice: { status: "draft" } }), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, spent: 1_500_000, period_end: (t + 86_400) * S + 7 * DAY });
    await apply(subscription(renewal), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, spent: 0, period_end: (t + 31 * 86_400) * S });
  });

  test("a trial that ends before its first charge keeps the trial's allowance and spending", async () => {
    await customer();
    await apply(subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    await env.DB.prepare("UPDATE members SET spent = 900000 WHERE id = 'm1'").run();
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start: t + 60, end: t + 60 + 30 * 86_400,
      latest_invoice: { status: "open" } }), now);
    expect(await memberRow()).toMatchObject({ allowance: 1_000_000, spent: 900_000, period_end: (t + 60) * S + 7 * DAY });
  });

  test("an unpaid invoice creates no member", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", latest_invoice: "in_1" }), now);
    expect(await memberRow()).toBeNull();
  });

  test("a failed payment never shortens access", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    await apply(subscription({ status: "past_due", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * S);
  });

  test("a failed payment keeps access for seven days past the paid period", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t }), now);
    await apply(subscription({ status: "past_due", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, period_end: t * S + 7 * DAY });
  });

  test("a canceled subscription ends access now and never extends an earlier end", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await apply(subscription({ status: "canceled", member: "m1" }), now);
    expect((await memberRow())!.period_end).toBe(now);
    await apply(subscription({ status: "canceled", member: "m1" }), now + 5000);
    expect((await memberRow())!.period_end).toBe(now);
  });

  test("an incomplete first payment grants nothing", async () => {
    await customer();
    await apply(subscription({ status: "incomplete", member: "m1" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "incomplete" });
  });

  test("a subscription with no member id, or an ended one for an unknown account, writes nothing", async () => {
    await customer();
    await apply(subscription({ status: "canceled", member: "nobody" }), now);
    await apply(subscription({ status: "active" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "none" });
    expect(await subRow("nobody")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a billable subscription for a deleted or deleting account is refunded and canceled", async () => {
    // m1 has no user row at all. m2 still has one, with an open deletion job.
    await user("m2");
    await env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES ('m2', ?)").bind(now).run();
    paidInvoices();
    routes["DELETE /subscriptions/sub_gone"] = () => subscription({ id: "sub_gone", status: "canceled" });
    routes["DELETE /subscriptions/sub_deleting"] = () => subscription({ id: "sub_deleting", status: "canceled" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await apply(subscription({ id: "sub_gone", status: "active", member: "m1", latest_invoice: { id: "in_gone" } }), now);
    await apply(subscription({ id: "sub_deleting", status: "past_due", member: "m2", customer: "cus_2",
      latest_invoice: { id: "in_deleting" } }), now);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_gone" }, { payment_intent: "pi_in_deleting" }]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_gone", "/subscriptions/sub_deleting"]);
    expect(events(logged)).toContainEqual({ event: "subscription_refunded", reason: "orphan", subscription: "sub_deleting" });
    expect(await subRow("m1")).toBeNull();
    expect(await subRow("m2")).toBeNull();
    expect(await memberRow("m1")).toBeNull();
  });

  test("a subscription for an account whose row is gone recreates the row and grants access", async () => {
    await user("m1");
    await apply(subscription({ status: "active", member: "m1", price: "price_pro" }), now);
    expect(await subRow()).toMatchObject({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan: "pro", status: "active" });
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000 });
    expect(calls).toHaveLength(0);
  });

  test("a billable subscription on another customer of a known account is logged, refunded and canceled; the row is kept", async () => {
    await user("m1");
    await customer();
    paidInvoices();
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", customer: "cus_other" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await apply(subscription({ status: "active", member: "m1", customer: "cus_other" }), now);
    expect(events(logged)).toContainEqual({ event: "subscription_customer_mismatch", member_id: "m1", subscription: "sub_1" });
    expect(events(logged)).toContainEqual({ event: "subscription_refunded", reason: "customer_mismatch", subscription: "sub_1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /invoice_payments", "POST /refunds", "DELETE /subscriptions/sub_1"]);
    expect(await subRow()).toMatchObject({ stripe_customer_id: "cus_1", status: "none", stripe_subscription_id: null });
    expect(await memberRow()).toBeNull();
  });

  test("an ended subscription on another customer of a known account is only logged", async () => {
    await user("m1");
    await customer();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await apply(subscription({ status: "canceled", member: "m1", customer: "cus_other" }), now);
    expect(events(logged)).toContainEqual({ event: "subscription_customer_mismatch", member_id: "m1", subscription: "sub_1" });
    expect(calls).toHaveLength(0);
    expect(await subRow()).toMatchObject({ stripe_customer_id: "cus_1", status: "none" });
  });

  test("a billable subscription whose customer belongs to another account is logged as a mismatch, refunded and canceled", async () => {
    await user("m1");
    await customer("m2", "cus_1");
    paidInvoices();
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await apply(subscription({ status: "active", member: "m1" }), now);
    expect(events(logged)).toContainEqual({ event: "subscription_customer_mismatch", member_id: "m1", subscription: "sub_1" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
    expect(await subRow("m1")).toBeNull();
    expect(await subRow("m2")).toMatchObject({ stripe_subscription_id: null, status: "none" });
  });

  test("a deletion that completes while the row is recreated leaves no row, and the subscription is refunded and canceled", async () => {
    await user("m1");
    paidInvoices();
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled" });
    // The deletion's batch lands between this apply's checks and its insert.
    const racing = { ...on, DB: { batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith("INSERT INTO subscriptions")) return statement;
        return { bind: (...values: unknown[]) => ({ run: async () => {
          await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind("m1").run();
          return statement.bind(...values).run();
        } }) };
      } } } as unknown as Env;
    await applySubscription(racing, subscription({ status: "active", member: "m1" }) as StripeSubscription, read(), now);
    expect(await subRow()).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
  });

  test("an unknown price on a live subscription fails so it is retried, and writes nothing", async () => {
    await customer();
    await expect(apply(subscription({ status: "active", member: "m1", price: "price_other" }), now)).rejects.toThrow();
    await apply(subscription({ status: "canceled", member: "m1", price: "price_other" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "none" });
  });

  test("a second live subscription is canceled at Stripe and changes nothing here", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }), now);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1" });
    routes["DELETE /subscriptions/sub_2"] = () => subscription({ id: "sub_2", status: "canceled", member: "m1" });
    await apply(subscription({ id: "sub_2", status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /subscriptions/sub_1", "DELETE /subscriptions/sub_2"]);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_1", plan: "starter" });
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("a new subscription replaces one Stripe already canceled, even before its webhook arrives", async () => {
    await customer();
    // The old subscription started earlier, so its period ends before the new one's.
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await apply(subscription({ id: "sub_2", status: "active", member: "m1", price: "price_pro" }), now);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_2", plan: "pro" });
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000 });
  });

  test("an old subscription ending does not touch the current one", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await apply(subscription({ id: "sub_0", status: "canceled", member: "m1" }), now);
    expect(await memberRow()).toMatchObject({ period_end: (t + 86_400) * S });
  });

  test("a subscription live on a comped account is refunded and canceled, and comp is untouched", async () => {
    await customer();
    await env.DB.prepare("INSERT INTO members(id, allowance, period_end, created_at, comp) VALUES ('m1', 8000000, ?, 0, 1)").bind(now + DAY).run();
    paidInvoices();
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await apply(subscription({ status: "active", member: "m1" }), now);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_1" }]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
    expect(await subRow()).toMatchObject({ status: "none" });
    await apply(subscription({ status: "canceled", member: "m1" }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, period_end: now + DAY, comp: 1 });
  });

  describe("a subscription for an account whose deletion is pending", () => {
    // As deleteAccount does: the member is revoked and deleted, and a job is queued for the sweep.
    async function deletionRequested(at: number, job = true) {
      await env.DB.prepare("INSERT INTO members(id, allowance, period_end, created_at, revoked, deleted_at) VALUES ('m1', 2000000, ?, 0, 1, ?)")
        .bind(now + DAY, at).run();
      if (job) await env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES ('m1', ?)").bind(at).run();
    }

    test("one paid after the request is refunded and canceled", async () => {
      await customer();
      await deletionRequested(now - 60_000);
      paidInvoices();
      routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await apply(subscription({ status: "active", member: "m1", latest_invoice: { id: "in_2", created: t } }), now);
      expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
      expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
      expect(events(logged)).toContainEqual({ event: "subscription_refunded", reason: "orphan", subscription: "sub_1" });
      expect(await subRow()).toMatchObject({ status: "none", stripe_subscription_id: null });
    });

    test("one created before the request but paid after it is refunded and canceled", async () => {
      await customer();
      await deletionRequested(now - 60_000);
      paidInvoices();
      routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
      // A renewal: Stripe creates the invoice at period start and charges it about an hour later.
      await apply(subscription({ status: "active", member: "m1",
        latest_invoice: { id: "in_2", created: t - 3600, status_transitions: { paid_at: t } } }), now);
      expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
      expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
    });

    test("one paid before the request is canceled with no refund when its invoice.paid replays", async () => {
      await customer();
      await deletionRequested(now - 60_000);
      routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await apply(subscription({ status: "active", member: "m1", latest_invoice: { id: "in_1", created: t - 10 * 86_400 } }), now);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /subscriptions/sub_1"]);
      expect(events(logged)).toContainEqual({ event: "subscription_canceled_for_deletion", subscription: "sub_1" });
      expect(await memberRow()).toMatchObject({ allowance: 2_000_000, period_end: now + DAY });
    });

    test("with no open job, the member's deleted_at is the request time", async () => {
      await customer();
      await deletionRequested(now - 60_000, false);
      paidInvoices();
      routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
      await apply(subscription({ status: "active", member: "m1", latest_invoice: { id: "in_2", created: t } }), now);
      expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    });
  });

  describe("a canceled subscription whose open invoice is paid", () => {
    const ended = t - 3600;
    // Paid on Stripe's invoice page after the end, as from an earlier failed-payment email.
    const late = { id: "in_2", created: ended - 86_400, status_transitions: { paid_at: t } };

    test("after it ended is refunded, and the row shows the cancel", async () => {
      await customer();
      await apply(subscription({ status: "active", member: "m1", start: t - 40 * 86_400, end: t - 10 * 86_400 }), now);
      await apply(subscription({ status: "past_due", member: "m1", start: t - 10 * 86_400, end: t + 20 * 86_400 }), now);
      paidInvoices();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await apply(subscription({ status: "canceled", member: "m1", ended_at: ended, latest_invoice: late }), now);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /invoice_payments", "POST /refunds"]);
      expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
      expect(events(logged)).toContainEqual({ event: "subscription_refunded", reason: "after_end", subscription: "sub_1" });
      expect(await subRow()).toMatchObject({ status: "canceled" });
      expect((await memberRow())!.period_end).toBeLessThanOrEqual(now);
    });

    test("after it ended is refunded for an account that is gone, with no row", async () => {
      paidInvoices();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await apply(subscription({ status: "canceled", member: "m1", ended_at: ended, latest_invoice: late }), now);
      expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
      expect(await subRow()).toBeNull();
    });

    test("while it still ran, under a cancel at period end, is kept", async () => {
      await customer();
      // A past-due invoice paid before the period ended bought that period.
      await apply(subscription({ status: "canceled", member: "m1", cancel_at_period_end: true, ended_at: t,
        latest_invoice: { id: "in_2", created: t - 10 * 86_400, status_transitions: { paid_at: t - 86_400 } } }), now);
      expect(calls).toHaveLength(0);
      expect(await subRow()).toMatchObject({ status: "canceled" });
    });

    test("is safe to read again once refunded", async () => {
      await customer();
      paidInvoices();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const sub = subscription({ status: "canceled", member: "m1", ended_at: ended, latest_invoice: late });
      await apply(sub, now);
      routes["POST /refunds"] = () => Response.json({ error: { type: "invalid_request_error", code: "charge_already_refunded" } }, { status: 400 });
      await apply(sub, now);
      expect(events(logged).filter((e) => e.event === "subscription_refunded")).toHaveLength(2);
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    });
  });

  test("a charged second subscription is refunded, then canceled", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }), now);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1" });
    paidInvoices();
    routes["DELETE /subscriptions/sub_2"] = () => subscription({ id: "sub_2", status: "canceled", member: "m1" });
    const from = Date.now();
    await apply(subscription({ id: "sub_2", status: "active", member: "m1", price: "price_pro", latest_invoice: { id: "in_2" } }), now);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /subscriptions/sub_1", "GET /invoice_payments", "POST /refunds",
      "DELETE /subscriptions/sub_2"]);
    expect(paramsOf(calls, "GET /invoice_payments")).toEqual([{ invoice: "in_2", status: "paid" }]);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_2" }]);
    expect(hourKeys("refund-in_2", from)).toContain(calls[2].headers.get("Idempotency-Key"));
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_1", plan: "starter" });
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("a refund Stripe already made counts as done, and a failed refund leaves the subscription for the retry", async () => {
    const sub = subscription({ id: "sub_2", status: "active", member: "m1", latest_invoice: { id: "in_2" } }) as StripeSubscription;
    paidInvoices();
    routes["POST /refunds"] = () => Response.json({ error: { type: "invalid_request_error", code: "charge_already_refunded" } }, { status: 400 });
    routes["DELETE /subscriptions/sub_2"] = () => ({ ...sub, status: "canceled" });
    await cancelAndRefund(on, sub, "duplicate");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    calls.length = 0;
    routes["POST /refunds"] = () => new Response("down", { status: 500 });
    await expect(cancelAndRefund(on, sub, "duplicate")).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  test("a refund that failed with a 500 is retried in the next hour with a new key, and refunds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const sub = subscription({ status: "active", member: "m1", latest_invoice: { id: "in_2" } }) as StripeSubscription;
      paidInvoices();
      routes["DELETE /subscriptions/sub_1"] = () => ({ ...sub, status: "canceled" });
      routes["POST /refunds"] = () => new Response("down", { status: 500 });
      vi.setSystemTime(Date.UTC(2026, 9, 26, 10, 59));
      await expect(cancelAndRefund(on, sub, "duplicate")).rejects.toMatchObject({ code: "billing_unavailable" });
      // Stripe replays a key's saved 500 for a day. A key from the next hour is a new request.
      paidInvoices();
      vi.setSystemTime(Date.UTC(2026, 9, 26, 11, 1));
      await cancelAndRefund(on, sub, "duplicate");
      const hours = [Date.UTC(2026, 9, 26, 10), Date.UTC(2026, 9, 26, 11)].map((at) => at / 3_600_000);
      expect(calls.filter((c) => c.path === "/refunds").map((c) => c.headers.get("Idempotency-Key"))).toEqual(hours.map((h) => `refund-in_2-${h}`));
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  test("a subscription Stripe already canceled is refunded but not canceled again, and a $0 trial invoice is not refunded", async () => {
    paidInvoices();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await cancelAndRefund(on, subscription({ status: "canceled" }) as StripeSubscription, "orphan");
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled" });
    await cancelAndRefund(on, subscription({ status: "trialing", trial_end: t + 60 }) as StripeSubscription, "orphan");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /invoice_payments", "POST /refunds", "DELETE /subscriptions/sub_1"]);
    expect(events(logged)).toEqual([{ event: "subscription_refunded", reason: "orphan", subscription: "sub_1" },
      { event: "subscription_canceled_unrefunded", reason: "orphan", subscription: "sub_1" }]);
  });

  test("an invoice read as a bare id is still refunded through its paid payments", async () => {
    paidInvoices();
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled" });
    await cancelAndRefund(on, subscription({ status: "active", latest_invoice: "in_9" }) as StripeSubscription, "duplicate");
    expect(paramsOf(calls, "GET /invoice_payments")).toEqual([{ invoice: "in_9", status: "paid" }]);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_9" }]);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  test("a refund Stripe refuses for good is logged, and the subscription is still canceled", async () => {
    paidInvoices();
    routes["POST /refunds"] = () => Response.json({ error: { type: "invalid_request_error", code: "charge_disputed" } }, { status: 400 });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await cancelAndRefund(on, subscription({ status: "active" }) as StripeSubscription, "duplicate");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(events(logged)).toContainEqual({ event: "refund_failed", subscription: "sub_1", reason: "duplicate", code: "stripe_rejected" });
    expect(events(logged)).toContainEqual({ event: "subscription_canceled_unrefunded", reason: "duplicate", subscription: "sub_1" });
    expect(events(logged).some((e) => e.event === "subscription_refunded")).toBe(false);
  });

  test("a rate-limited refund fails like an outage, so the webhook retries before any cancel", async () => {
    paidInvoices();
    routes["POST /refunds"] = () => Response.json({ error: { type: "invalid_request_error", code: "rate_limit" } }, { status: 429 });
    await expect(cancelAndRefund(on, subscription({ status: "active" }) as StripeSubscription, "duplicate"))
      .rejects.toMatchObject({ code: "billing_unavailable" });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  test("two reads stamped in the same millisecond: only the apply that won changes the member", async () => {
    await customer();
    const tt = t - 3 * 86_400;
    await apply(subscription({ status: "active", member: "m1", start: tt - 30 * 86_400, end: tt }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const frozen = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    // The first read sees a paid renewal; the second, taken in the same ms, sees the cancel. The first apply loses.
    const reads = [subscription({ status: "active", member: "m1", start: tt, end: tt + 30 * 86_400 }),
      subscription({ status: "canceled", member: "m1", start: tt, end: tt + 30 * 86_400 })];
    routes["GET /subscriptions/sub_1"] = () => reads.shift() ?? new Response("down", { status: 500 });
    const held = gated();
    const renewal = syncSubscription(held.env, "sub_1");
    await held.atBatch;
    await syncSubscription(on, "sub_1");
    held.open();
    // Its retry finds Stripe down, so what stands is the two first applies.
    await expect(renewal).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(await memberRow()).toMatchObject({ spent: 1_500_000, period_end: tt * S });
    expect(await subRow()).toMatchObject({ status: "canceled" });
  });

  test("a stale read written after a newer one loses, so a paying member keeps the paid allowance", async () => {
    await customer();
    const trial = subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 });
    await apply(trial, now);
    const held = gated();
    const stale = applySubscription(held.env, trial, read(), now);
    await held.atBatch;
    await apply(subscription({ status: "active", member: "m1", price: "price_pro", start: t + 60, end: t + 60 + 30 * 86_400 }), now);
    held.open();
    expect(await stale).toBe(false);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, period_end: (t + 60 + 30 * 86_400) * S });
    expect(await subRow()).toMatchObject({ status: "active", current_period_end: (t + 60 + 30 * 86_400) * S });
  });

  test("an old subscription's cancel, read before a new one lands, does not cut off the new one", async () => {
    await customer();
    await apply(subscription({ id: "sub_A", status: "active", member: "m1", end: t + 60 }), now);
    routes["GET /subscriptions/sub_A"] = () => subscription({ id: "sub_A", status: "canceled", member: "m1" });
    const held = gated();
    const stale = applySubscription(held.env, subscription({ id: "sub_A", status: "canceled", member: "m1", end: t + 60 }), read(), now + 120_000);
    await held.atBatch;
    await apply(subscription({ id: "sub_B", status: "active", member: "m1", start: t + 100, end: t + 100 + 30 * 86_400 }), now + 120_000);
    held.open();
    expect(await stale).toBe(false);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_B", status: "active" });
    expect((await memberRow())!.period_end).toBe((t + 100 + 30 * 86_400) * S);
  });

  test("a read whose row changed under it loses, even when its read is newer", async () => {
    await customer();
    await apply(subscription({ id: "sub_A", status: "active", member: "m1", end: t + 60 }), now);
    routes["GET /subscriptions/sub_A"] = () => subscription({ id: "sub_A", status: "canceled", member: "m1" });
    const held = gated();
    const stale = applySubscription(held.env, subscription({ id: "sub_A", status: "canceled", member: "m1" }), (Date.now() + 60_000) * 1000, now);
    await held.atBatch;
    await apply(subscription({ id: "sub_B", status: "active", member: "m1", end: t + 30 * 86_400 }), now);
    held.open();
    expect(await stale).toBe(false);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_B", status: "active" });
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * S);
  });

  test("two first subscriptions applied together keep one; the other is refunded and canceled", async () => {
    await customer();
    const first = subscription({ id: "sub_A", status: "active", member: "m1", latest_invoice: { id: "in_A" } });
    const second = subscription({ id: "sub_B", status: "active", member: "m1", latest_invoice: { id: "in_B" } });
    routes["GET /subscriptions/sub_A"] = () => first;
    routes["GET /subscriptions/sub_B"] = () => second;
    paidInvoices();
    routes["DELETE /subscriptions/sub_B"] = () => ({ ...second, status: "canceled" });
    const held = gated();
    const late = syncSubscription(held.env, "sub_B");
    await held.atBatch;
    await syncSubscription(on, "sub_A");
    held.open();
    await late;
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_B"]);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_B" }]);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_A", status: "active" });
  });

  test("a sync that keeps losing to newer reads fails, so its caller retries", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }), now);
    await env.DB.prepare("UPDATE subscriptions SET synced_at = ? WHERE member_id = 'm1'").bind((Date.now() + DAY) * 1000).run();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "past_due", member: "m1" });
    await expect(syncSubscription(on, "sub_1")).rejects.toThrow("subscription_apply_contended");
    expect(paramsOf(calls, "GET /subscriptions/sub_1")).toHaveLength(3);
    expect(await subRow()).toMatchObject({ status: "active" });
  });
});

describe("the Stripe webhook", () => {
  async function deliver(event: Record<string, unknown>, signature?: string) {
    const body = JSON.stringify(event);
    return worker.fetch(new Request("http://localhost:8787/webhooks/stripe", { method: "POST",
      headers: { "Stripe-Signature": signature ?? await sign(body), "cf-connecting-ip": "3.18.12.63" }, body }), on as never, createExecutionContext());
  }

  test("a subscription event reads the subscription from Stripe and applies it", async () => {
    await customer();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1", price: "price_pro" });
    const response = await deliver({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "trialing" } } });
    expect(response.status).toBe(200);
    expect(calls[0].params.get("expand[0]")).toBe("latest_invoice");
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000 });
  });

  test("a paid invoice finds its subscription under parent", async () => {
    await customer();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1" });
    const response = await deliver({ id: "evt_2", type: "invoice.paid",
      data: { object: { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } } } } });
    expect(response.status).toBe(200);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("a paid invoice in a pre-basil payload finds its subscription at the top level", async () => {
    await customer();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1" });
    const response = await deliver({ id: "evt_7", type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_1" } } });
    expect(response.status).toBe(200);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("a paid invoice with no subscription is acknowledged and logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver({ id: "evt_8", type: "invoice.paid", data: { object: { id: "in_1", parent: null } } })).status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(events(logged)).toContainEqual({ event: "stripe_event_unmatched", id: "evt_8", type: "invoice.paid" });
  });

  test("each refused delivery logs why", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = async (body: string, signature: string, target = on) => (await worker.fetch(new Request("http://localhost:8787/webhooks/stripe",
      { method: "POST", headers: { "Stripe-Signature": signature }, body }), target as never, createExecutionContext())).status;
    const event = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    expect(await post(event, "t=1,v1=00")).toBe(400);
    expect(await post("not json", await sign("not json"))).toBe(400);
    expect(await post("{\"id\":1}", await sign("{\"id\":1}"))).toBe(400);
    expect(await post(event, await sign(event), { ...on, STRIPE_WEBHOOK_SECRET: undefined } as Env)).toBe(404);
    expect(events(logged).filter((e) => e.event === "stripe_webhook_rejected")).toEqual(
      ["signature", "unreadable", "unreadable", "not_configured"].map((reason) => ({ event: "stripe_webhook_rejected", reason })));
  });

  test("a bad signature is refused before any Stripe call", async () => {
    const response = await deliver({ id: "evt_3", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } }, "t=1,v1=00");
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("an event type the proxy does not use is acknowledged and ignored", async () => {
    expect((await deliver({ id: "evt_4", type: "charge.succeeded", data: { object: { id: "ch_1" } } })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("when Stripe cannot be read, the webhook fails so Stripe retries, and nothing is written", async () => {
    await customer();
    routes["GET /subscriptions/sub_1"] = () => new Response("down", { status: 500 });
    expect((await deliver({ id: "evt_5", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } })).status).toBe(503);
    expect(await memberRow()).toBeNull();
  });

  test("a live subscription with an unknown price fails the webhook so Stripe retries", async () => {
    await customer();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1", price: "price_other" });
    expect((await deliver({ id: "evt_6", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } })).status).not.toBe(200);
    expect(await memberRow()).toBeNull();
  });

  test("a body that is not JSON is refused", async () => {
    const body = "not json";
    const response = await worker.fetch(new Request("http://localhost:8787/webhooks/stripe", { method: "POST",
      headers: { "Stripe-Signature": await sign(body) }, body }), on as never, createExecutionContext());
    expect(response.status).toBe(400);
  });

  test("webhooks skip the per-IP limit", async () => {
    for (let i = 0; i < 125; i++) {
      expect((await deliver({ id: `evt_${i}`, type: "charge.succeeded", data: { object: { id: "ch_1" } } })).status).toBe(200);
    }
  });
});

test("the return page tells her to go back to the app", async () => {
  const done = await api("/billing/done");
  expect(done.headers.get("Content-Type")).toContain("text/html");
  expect(await done.text()).toContain("Go back to Mixing Pal.");
  expect(await (await api("/billing/done?state=canceled")).text()).toContain("Nothing was charged.");
});

describe("public sign-up", () => {
  test("with billing on, an email with no invite signs in and is asked to pick a plan", async () => {
    const user = await signedIn();
    expect(await (await api("/v1/account", undefined, user.token)).json())
      .toMatchObject({ access: "plan_required", trial_available: true, can_ask: false, plan: null, manage: false, comp: false });
  });

  test("an app without the version header sees expired, which it already shows", async () => {
    const user = await signedIn();
    expect((await (await api("/v1/account", undefined, user.token, { modern: false })).json()).access).toBe("expired");
  });

  test("with billing off, nothing changes for invites", async () => {
    const off = { ...on, BILLING_ENABLED: "false" } as Env;
    expect((await api("/auth/email-otp/send-verification-otp", { email: "stranger@example.com" }, undefined, { env: off })).status).toBe(200);
    expect(otp).toBe("");
  });

  test("an ended pilot period asks for a plan, with no trial", async () => {
    const user = await signedIn();
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at) VALUES (?, ?, 0)").bind(user.id, Date.now() - 1000).run();
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "plan_required", trial_available: false });
  });

  test("a trial canceled in the Portal runs to its end and is not offered again", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "trialing", member: user.id, trial_end: t + 86_400, cancel_at_period_end: true }));
    expect(await (await api("/v1/account", undefined, user.token)).json())
      .toMatchObject({ access: "active", subscription_status: "trialing", cancel_at_period_end: true, manage: true });
    await apply(subscription({ status: "canceled", member: user.id }));
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "plan_required", trial_available: false });
  });

  test("an active subscription shows its plan", async () => {
    const user = await signedIn();
    await customer(user.id);
    await apply(subscription({ status: "active", member: user.id, price: "price_pro" }));
    expect(await (await api("/v1/account", undefined, user.token)).json())
      .toMatchObject({ access: "active", plan: "pro", subscription_status: "active", can_ask: true, remaining_micro_usd: 8_000_000 });
  });

  test("one IP gets ten code sends an hour", async () => {
    for (let i = 0; i < 10; i++) expect((await api("/auth/email-otp/send-verification-otp", { email: `p${i}@example.com` })).status).toBe(200);
    expect((await api("/auth/email-otp/send-verification-otp", { email: "p10@example.com" })).status).toBe(429);
  });

  test("a deleted account's email cannot sign in again until the deletion finishes", async () => {
    const user = await signedIn();
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at, deleted_at) VALUES (?, 0, 0, 1)").bind(user.id).run();
    otp = "";
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    expect(otp).toBe("");
  });

  test("an account that never subscribed cannot sign in again while its deletion is pending", async () => {
    const user = await signedIn();
    expect((await api("/v1/account", undefined, user.token, { method: "DELETE" })).status).toBe(202);
    otp = "";
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    expect(otp).toBe("");
  });

  test("invites are retired", async () => {
    const user = await signedIn();
    expect((await api("/v1/invites/redeem", { code: "x".repeat(40) }, user.token)).status).toBe(410);
    const invite = await worker.fetch(new Request("http://localhost:8787/operator", { method: "POST",
      headers: { Authorization: "Bearer test-operator-key", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invite", email: "new@example.com" }) }), on as never, createExecutionContext());
    expect(invite.status).toBe(409);
  });
});

describe("billing routes", () => {
  beforeEach(() => {
    routes["POST /customers"] = () => ({ id: "cus_1" });
    routes["POST /checkout/sessions"] = () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    routes["POST /billing_portal/sessions"] = () => ({ url: "https://billing.stripe.com/p/session/1" });
    routes["GET /subscriptions"] = () => ({ data: [] });
    routes["GET /customers/search"] = () => ({ data: [] });
    routes["GET /customers/cus_1"] = () => ({ id: "cus_1", object: "customer" });
  });
  const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
  const checkoutUrl = { url: "https://checkout.stripe.com/c/pay/cs_1" };
  const portalUrl = { url: "https://billing.stripe.com/p/session/1" };
  const invoicePage = "https://invoice.stripe.com/i/in_2";

  test("a new account's checkout creates one customer and a session with a 7-day trial", async () => {
    const user = await signedIn();
    const from = Date.now();
    const response = await api("/v1/billing/checkout", { plan: "pro" }, user.token);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(posted("/customers")[0].params.get("metadata[member_id]")).toBe(user.id);
    expect(hourKeys(`customer-${user.id}`, from)).toContain(posted("/customers")[0].headers.get("Idempotency-Key"));
    const session = posted("/checkout/sessions")[0].params;
    expect(Object.fromEntries(session)).toMatchObject({ mode: "subscription", customer: "cus_1", "line_items[0][price]": "price_pro",
      "line_items[0][quantity]": "1", "subscription_data[metadata][member_id]": user.id, "subscription_data[trial_period_days]": "7",
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel", payment_method_collection: "always",
      "automatic_tax[enabled]": "true", "customer_update[address]": "auto", success_url: "http://localhost:8787/billing/done",
      cancel_url: "http://localhost:8787/billing/done?state=canceled" });
  });

  test("a second checkout reuses the customer", async () => {
    const user = await signedIn();
    await api("/v1/billing/checkout", { plan: "starter" }, user.token);
    await api("/v1/billing/checkout", { plan: "pro" }, user.token);
    expect(posted("/customers")).toHaveLength(1);
    expect(posted("/checkout/sessions")).toHaveLength(2);
  });

  test("opening Checkout keeps a sign-up older than 90 days through the cleanup", async () => {
    const user = await signedIn();
    await env.DB.prepare('UPDATE "user" SET createdAt = ? WHERE id = ?').bind(new Date(Date.now() - 91 * DAY).toISOString(), user.id).run();
    await customer(user.id);
    expect((await api("/v1/billing/checkout", { plan: "starter" }, user.token)).status).toBe(200);
    await maintain(on);
    expect(await subRow(user.id)).toMatchObject({ stripe_customer_id: "cus_1" });
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(user.id).first()).toEqual({ id: user.id });
  });

  test("a used trial and a lapsed pilot member get no trial", async () => {
    const user = await signedIn();
    await customer(user.id);
    await env.DB.prepare("UPDATE subscriptions SET trial_used = 1 WHERE member_id = ?").bind(user.id).run();
    await api("/v1/billing/checkout", { plan: "starter" }, user.token);
    expect(posted("/checkout/sessions")[0].params.has("subscription_data[trial_period_days]")).toBe(false);
    const pilot = await signedIn("pilot@example.com");
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at) VALUES (?, ?, 0)").bind(pilot.id, Date.now() - 1000).run();
    routes["POST /customers"] = () => ({ id: "cus_2" });
    await api("/v1/billing/checkout", { plan: "starter" }, pilot.token);
    expect(posted("/checkout/sessions")[1].params.has("subscription_data[trial_period_days]")).toBe(false);
  });

  test("a live subscription gets the Portal instead of a second checkout", async () => {
    const user = await signedIn();
    await customer(user.id);
    await apply(subscription({ status: "active", member: user.id }));
    expect(await (await api("/v1/billing/checkout", { plan: "pro" }, user.token)).json()).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(posted("/checkout/sessions")).toHaveLength(0);
  });

  test("a checkout whose first webhook was lost gets the Portal, and access from Stripe's state", async () => {
    const user = await signedIn();
    await customer(user.id);
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: user.id, price: "price_pro" })] });
    expect(await (await api("/v1/billing/checkout", { plan: "pro" }, user.token)).json()).toEqual(portalUrl);
    expect(paramsOf(calls, "GET /subscriptions")).toEqual([{ customer: "cus_1", status: "all", limit: "10", "expand[0]": "data.latest_invoice" }]);
    expect(posted("/checkout/sessions")).toHaveLength(0);
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "active", plan: "pro" });
  });

  test("the 90-day cleanup running while checkout waits on Stripe keeps the account and its customer", async () => {
    const user = await signedIn();
    await env.DB.prepare('UPDATE "user" SET createdAt = ? WHERE id = ?').bind(new Date(Date.now() - 100 * DAY).toISOString(), user.id).run();
    await customer(user.id);
    routes["GET /subscriptions"] = async () => {
      await maintain(on);
      return { data: [] };
    };
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(await subRow(user.id)).toMatchObject({ stripe_customer_id: "cus_1" });
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(user.id).first()).toEqual({ id: user.id });
  });

  test("an account deleted while checkout waits on Stripe gets no Checkout session", async () => {
    const user = await signedIn();
    await customer(user.id);
    // Sign-in already refuses a pending deletion; this one is requested from another window mid-call.
    routes["GET /subscriptions"] = async () => {
      await env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES (?, ?)").bind(user.id, Date.now()).run();
      return { data: [] };
    };
    const response = await api("/v1/billing/checkout", { plan: "starter" }, user.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "access_denied", message: "This account cannot subscribe." } });
    expect(posted("/checkout/sessions")).toHaveLength(0);
  });

  test("checkout reuses a Stripe customer found by member id, so a restored database makes no second customer", async () => {
    const user = await signedIn();
    routes["GET /customers/search"] = () => ({ data: [{ id: "cus_found" }] });
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: user.id, customer: "cus_found" })] });
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(paramsOf(calls, "GET /customers/search")).toEqual([{ query: `metadata['member_id']:'${user.id}'` }]);
    expect(posted("/customers")).toHaveLength(0);
    expect(paramsOf(calls, "GET /subscriptions")).toMatchObject([{ customer: "cus_found" }]);
    expect(posted("/checkout/sessions")[0].params.get("customer")).toBe("cus_found");
    // The restored member used the trial before; the row that recorded it was lost.
    expect(posted("/checkout/sessions")[0].params.has("subscription_data[trial_period_days]")).toBe(false);
    expect(await subRow(user.id)).toMatchObject({ stripe_customer_id: "cus_found" });
  });

  test("a found customer that never held a subscription gets the trial, as after a failed first try", async () => {
    const user = await signedIn();
    // The customer was created, then storing its row failed.
    routes["GET /customers/search"] = () => ({ data: [{ id: "cus_found" }] });
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(posted("/customers")).toHaveLength(0);
    expect(posted("/checkout/sessions")[0].params.get("customer")).toBe("cus_found");
    expect(posted("/checkout/sessions")[0].params.get("subscription_data[trial_period_days]")).toBe("7");
  });

  test("a cached unpaid subscription that Stripe has since canceled lets the member check out again", async () => {
    const user = await signedIn();
    await customer(user.id);
    await env.DB.prepare("UPDATE subscriptions SET stripe_subscription_id = 'sub_1', status = 'unpaid', trial_used = 1 WHERE member_id = ?")
      .bind(user.id).run();
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: user.id })] });
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(await subRow(user.id)).toMatchObject({ status: "canceled" });
  });

  test("a found customer that still pays for a plan gets the Portal and its access back", async () => {
    const user = await signedIn();
    routes["GET /customers/search"] = () => ({ data: [{ id: "cus_found" }] });
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: user.id, customer: "cus_found" })] });
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(portalUrl);
    expect(posted("/checkout/sessions")).toHaveLength(0);
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "active", plan: "starter" });
  });

  test("an account removed while its customer is created stores nothing and must sign in again", async () => {
    const user = await signedIn();
    routes["POST /customers"] = async () => {
      await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(user.id).run();
      return { id: "cus_1" };
    };
    const response = await api("/v1/billing/checkout", { plan: "starter" }, user.token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "sign_in_required" } });
    expect(await subRow(user.id)).toBeNull();
    expect(posted("/checkout/sessions")).toHaveLength(0);
  });

  test("a row whose customer Stripe no longer has gets a new customer and a Checkout", async () => {
    const user = await signedIn();
    await customer(user.id, "cus_dead");
    await env.DB.prepare("UPDATE subscriptions SET status = 'canceled', trial_used = 1 WHERE member_id = ?").bind(user.id).run();
    routes["GET /subscriptions"] = missing;
    // Stripe answers a deleted customer with its deleted mark, not "not found".
    routes["GET /customers/cus_dead"] = () => ({ id: "cus_dead", object: "customer", deleted: true });
    routes["POST /customers"] = () => ({ id: "cus_new" });
    const from = Date.now();
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(paramsOf(calls, "GET /customers/search")).toEqual([{ query: `metadata['member_id']:'${user.id}'` }]);
    // Not the first customer's key: Stripe would replay the deleted customer for a day.
    expect(hourKeys(`customer-${user.id}-cus_dead`, from)).toContain(posted("/customers")[0].headers.get("Idempotency-Key"));
    expect(posted("/checkout/sessions")[0].params.get("customer")).toBe("cus_new");
    expect(posted("/checkout/sessions")[0].params.has("subscription_data[trial_period_days]")).toBe(false);
    expect(await subRow(user.id)).toMatchObject({ stripe_customer_id: "cus_new", status: "canceled" });
  });

  test("a deleted customer whose subscription list still answers gets a new customer and a Checkout", async () => {
    const user = await signedIn();
    await customer(user.id, "cus_dead");
    await env.DB.prepare("UPDATE subscriptions SET stripe_subscription_id = 'sub_1', status = 'canceled', trial_used = 1 WHERE member_id = ?")
      .bind(user.id).run();
    // Stripe keeps a deleted customer readable, and deleting it canceled its subscriptions.
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: user.id, customer: "cus_dead" })] });
    routes["GET /customers/cus_dead"] = () => ({ id: "cus_dead", object: "customer", deleted: true });
    routes["POST /customers"] = () => ({ id: "cus_new" });
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, user.token)).json()).toEqual(checkoutUrl);
    expect(posted("/checkout/sessions")[0].params.get("customer")).toBe("cus_new");
    expect(await subRow(user.id)).toMatchObject({ stripe_customer_id: "cus_new" });
  });

  test("checkout offers cards only; Apple Pay and Google Pay are card payments", async () => {
    const user = await signedIn();
    await api("/v1/billing/checkout", { plan: "starter" }, user.token);
    expect(posted("/checkout/sessions")[0].params.getAll("allowed_payment_method_types[0]")).toEqual(["card"]);
    expect(posted("/checkout/sessions")[0].params.has("allowed_payment_method_types[1]")).toBe(false);
    expect(posted("/checkout/sessions")[0].params.has("payment_method_types[0]")).toBe(false);
  });

  test("a refused pilot member gets no Stripe customer", async () => {
    const pilot = await signedIn();
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at) VALUES (?, ?, 0)").bind(pilot.id, Date.now() + DAY).run();
    expect((await api("/v1/billing/checkout", { plan: "starter" }, pilot.token)).status).toBe(409);
    expect(posted("/customers")).toHaveLength(0);
    expect(await subRow(pilot.id)).toBeNull();
  });

  test("an active pilot member and a comped account cannot check out", async () => {
    const pilot = await signedIn();
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at) VALUES (?, ?, 0)").bind(pilot.id, Date.now() + DAY).run();
    expect((await api("/v1/billing/checkout", { plan: "starter" }, pilot.token)).status).toBe(409);
    await env.DB.prepare("UPDATE members SET comp = 1 WHERE id = ?").bind(pilot.id).run();
    expect(await (await api("/v1/billing/checkout", { plan: "starter" }, pilot.token)).json()).toMatchObject({ error: { code: "comp_active" } });
  });

  test("checkout is not found with billing off", async () => {
    const user = await signedIn();
    expect((await api("/v1/billing/checkout", { plan: "pro" }, user.token, { env: { ...on, BILLING_ENABLED: "false" } as Env })).status).toBe(404);
  });

  test("when Stripe is down, checkout says so and stores nothing", async () => {
    const user = await signedIn();
    routes["POST /customers"] = () => new Response("down", { status: 500 });
    const response = await api("/v1/billing/checkout", { plan: "pro" }, user.token);
    expect(response.status).toBe(503);
    expect(await subRow(user.id)).toBeNull();
  });

  test("the Portal needs a subscription, and returns to the done page", async () => {
    const user = await signedIn();
    expect((await api("/v1/billing/portal", {}, user.token)).status).toBe(404);
    await customer(user.id);
    await apply(subscription({ status: "active", member: user.id }));
    expect((await api("/v1/billing/portal", {}, user.token)).status).toBe(200);
    expect(posted("/billing_portal/sessions")[0].params.get("return_url")).toBe("http://localhost:8787/billing/done?state=portal");
  });

  test("start-now ends the trial at Stripe and gives the tier's allowance at once", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "trialing", member: user.id, price: "price_pro", trial_end: t + 86_400 }));
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, price: "price_pro", start: t, end: t + 30 * 86_400 });
    const view = await (await api("/v1/billing/start-now", {}, user.token)).json();
    expect(posted("/subscriptions/sub_1")[0].params.get("trial_end")).toBe("now");
    expect(posted("/subscriptions/sub_1")[0].params.get("expand[0]")).toBe("latest_invoice");
    expect(view).toMatchObject({ access: "active", subscription_status: "active", remaining_micro_usd: 8_000_000 });
  });

  test("start-now whose result loses to a newer read applies Stripe's state again", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "trialing", member: user.id, price: "price_pro", trial_end: t + 86_400 }));
    const paid = subscription({ status: "active", member: user.id, price: "price_pro", start: t, end: t + 30 * 86_400 });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    routes["POST /subscriptions/sub_1"] = async () => {
      // A webhook's read, taken after this call started, lands first: its invoice was still open.
      await pause();
      await applySubscription(on, subscription({ status: "active", member: user.id, price: "price_pro", start: t, end: t + 30 * 86_400,
        latest_invoice: { status: "open" } }), readStamp());
      await pause();
      return paid;
    };
    routes["GET /subscriptions/sub_1"] = () => paid;
    const view = await (await api("/v1/billing/start-now", {}, user.token)).json();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /subscriptions/sub_1", "GET /subscriptions/sub_1"]);
    expect(view).toMatchObject({ access: "active", subscription_status: "active", remaining_micro_usd: 8_000_000 });
  });

  test("an upgrade whose result loses to a newer read applies Stripe's state again", async () => {
    const user = await signedIn();
    await customer(user.id);
    const end = Math.floor(Date.now() / 1000) + 86_400;
    const start = end - 30 * 86_400;
    await apply(subscription({ status: "active", member: user.id, start, end }));
    await env.DB.prepare("UPDATE members SET spent = 1800000 WHERE id = ?").bind(user.id).run();
    // Upgraded on the period's first day, so the whole of Pro's extra applies.
    const upgraded = subscription({ status: "active", member: user.id, price: "price_pro", start, end,
      latest_invoice: { id: "in_2", billing_reason: "subscription_update", created: start } });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    routes["GET /subscriptions/sub_1"] = () => upgraded;
    routes["POST /subscriptions/sub_1"] = async () => {
      // A webhook's read, taken after this call started, lands first: the proration invoice was still open.
      await pause();
      await applySubscription(on, subscription({ status: "active", member: user.id, price: "price_pro", start, end,
        latest_invoice: { status: "open" } }), readStamp());
      await pause();
      return upgraded;
    };
    const view = await (await api("/v1/billing/upgrade", {}, user.token)).json();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /subscriptions/sub_1", "POST /subscriptions/sub_1", "GET /subscriptions/sub_1"]);
    expect(view).toMatchObject({ plan: "pro", remaining_micro_usd: 6_200_000 });
  });

  test("start-now needs a trial", async () => {
    const user = await signedIn();
    expect((await api("/v1/billing/start-now", {}, user.token)).status).toBe(409);
  });

  test("an upgrade swaps the price with an immediate prorated charge and keeps what she spent", async () => {
    const user = await signedIn();
    await customer(user.id);
    // One fixed period end: a different end would read as a renewal and reset spending.
    const end = Math.floor(Date.now() / 1000) + 86_400;
    const start = end - 30 * 86_400;
    await apply(subscription({ status: "active", member: user.id, start, end }));
    await env.DB.prepare("UPDATE members SET spent = 1800000 WHERE id = ?").bind(user.id).run();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, start, end });
    // Upgraded on the period's first day, so the whole of Pro's extra applies.
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, price: "price_pro", start, end,
      latest_invoice: { id: "in_2", billing_reason: "subscription_update", created: start } });
    const view = await (await api("/v1/billing/upgrade", {}, user.token)).json();
    expect(Object.fromEntries(posted("/subscriptions/sub_1")[0].params)).toMatchObject({ "items[0][id]": "si_1",
      "items[0][price]": "price_pro", proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete",
      "expand[0]": "latest_invoice" });
    expect(view).toMatchObject({ plan: "pro", remaining_micro_usd: 6_200_000 });
  });

  test("an upgrade charged at Stripe whose write then fails answers 503, and the webhook's apply grants the prorated Pro allowance", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    const start = t - 15 * 86_400;
    const end = t + 15 * 86_400;
    await apply(subscription({ status: "active", member: user.id, start, end }));
    await env.DB.prepare("UPDATE members SET spent = 1800000 WHERE id = ?").bind(user.id).run();
    // Upgraded at the period's midpoint and paid at once.
    const upgraded = subscription({ status: "active", member: user.id, price: "price_pro", start, end,
      latest_invoice: { id: "in_2", billing_reason: "subscription_update", created: t } });
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, start, end });
    let charged = false;
    routes["POST /subscriptions/sub_1"] = () => { charged = true; return upgraded; };
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (charged) { charged = false; throw new Error("D1_ERROR: unavailable"); }
      return batch(statements);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await api("/v1/billing/upgrade", {}, user.token);
    expect(response.status).toBe(503);
    expect(await memberRow(user.id)).toMatchObject({ allowance: 2_000_000, spent: 1_800_000 });
    expect(await subRow(user.id)).toMatchObject({ plan: "starter" });
    // invoice.paid arrives: the webhook reads the subscription and applies it.
    routes["GET /subscriptions/sub_1"] = () => upgraded;
    await syncSubscription(on, "sub_1");
    expect(await memberRow(user.id)).toMatchObject({ allowance: 5_000_000, spent: 1_800_000 });
    expect(await subRow(user.id)).toMatchObject({ plan: "pro" });
  });

  test("a declined upgrade leaves Starter in place and says the card was declined", async () => {
    const user = await signedIn();
    await customer(user.id);
    const end = Math.floor(Date.now() / 1000) + 86_400;
    await apply(subscription({ status: "active", member: user.id, end }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end });
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end, pending_update: { expires_at: 1 } });
    const response = await api("/v1/billing/upgrade", {}, user.token);
    expect(response.status).toBe(402);
    expect(await memberRow(user.id)).toMatchObject({ allowance: 2_000_000 });
  });

  test("only an active Starter plan can upgrade", async () => {
    const user = await signedIn();
    await customer(user.id);
    await apply(subscription({ status: "active", member: user.id, price: "price_pro" }));
    expect((await api("/v1/billing/upgrade", {}, user.token)).status).toBe(409);
  });

  test("an upgrade while the renewal is still unpaid is refused, with no change at Stripe", async () => {
    const user = await signedIn();
    await customer(user.id);
    const end = Math.floor(Date.now() / 1000) - 60;
    await apply(subscription({ status: "active", member: user.id, end }));
    // Stripe has moved the period; the renewal invoice is not paid yet.
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, start: end, end: end + 30 * 86_400,
      latest_invoice: { status: "draft" } });
    const response = await api("/v1/billing/upgrade", {}, user.token);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "renewal_pending", message: "Your renewal is still processing. Try again in an hour." } });
    expect(posted("/subscriptions/sub_1")).toHaveLength(0);
  });

  test("an upgrade whose charge needs the member is sent to the invoice page, and stays Starter", async () => {
    const user = await signedIn();
    await customer(user.id);
    const end = Math.floor(Date.now() / 1000) + 86_400;
    await apply(subscription({ status: "active", member: user.id, end }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end });
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end, pending_update: { expires_at: 1 },
      latest_invoice: { id: "in_2", status: "open", amount_paid: 0, hosted_invoice_url: invoicePage } });
    const response = await api("/v1/billing/upgrade", {}, user.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: invoicePage });
    expect(await subRow(user.id)).toMatchObject({ plan: "starter" });
    expect(await memberRow(user.id)).toMatchObject({ allowance: 2_000_000 });
  });

  test("start-now whose first charge is not paid sends the member to the invoice page", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "trialing", member: user.id, price: "price_pro", trial_end: t + 86_400 }));
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, price: "price_pro", start: t, end: t + 30 * 86_400,
      latest_invoice: { id: "in_2", status: "open", amount_paid: 0, hosted_invoice_url: invoicePage } });
    const response = await api("/v1/billing/start-now", {}, user.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: invoicePage });
    expect(await memberRow(user.id)).toMatchObject({ allowance: 1_000_000 });
  });
});

describe("comp and renewals", () => {
  async function operate(body: unknown) {
    return worker.fetch(new Request("http://localhost:8787/operator", { method: "POST",
      headers: { Authorization: "Bearer test-operator-key", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      on as never, createExecutionContext());
  }

  test("comp gives Pro's allowance for 30 days and is recorded", async () => {
    const user = await signedIn();
    const response = await operate({ action: "comp", email: "Producer@example.com" });
    expect(await response.json()).toEqual({ member_id: user.id });
    const row = await memberRow(user.id);
    expect(row).toMatchObject({ allowance: 8_000_000, comp: 1 });
    expect(row!.period_end).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(await env.DB.prepare("SELECT target FROM operator_actions WHERE action = 'comp'").first()).toEqual({ target: user.id });
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "active", comp: true });
  });

  test("comp needs a signed-in account and refuses one with a live subscription", async () => {
    expect((await operate({ action: "comp", email: "nobody@example.com" })).status).toBe(404);
    const user = await signedIn();
    await customer(user.id);
    await apply(subscription({ status: "active", member: user.id }));
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: user.id })] });
    expect((await operate({ action: "comp", email: "producer@example.com" })).status).toBe(409);
  });

  test("comp is refused when Stripe has a live subscription our row has not seen", async () => {
    const user = await signedIn();
    await customer(user.id);
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: user.id })] });
    const response = await operate({ action: "comp", email: "producer@example.com" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "subscription_live" } });
    expect(await memberRow(user.id)).toMatchObject({ comp: 0 });
    expect(calls.some((c) => c.path === "/checkout/sessions")).toBe(false);
  });

  test("comp for an account whose Stripe customer was deleted grants as if Stripe had nothing", async () => {
    const user = await signedIn();
    await customer(user.id);
    routes["GET /subscriptions"] = missing;
    routes["GET /customers/cus_1"] = () => ({ id: "cus_1", object: "customer", deleted: true });
    routes["GET /checkout/sessions"] = missing;
    expect((await operate({ action: "comp", email: "producer@example.com" })).status).toBe(200);
    expect(await memberRow(user.id)).toMatchObject({ comp: 1 });
  });

  test("comp expires the account's open Checkout sessions before it grants", async () => {
    const user = await signedIn();
    await customer(user.id);
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: user.id })] });
    routes["GET /checkout/sessions"] = () => ({ data: [{ id: "cs_1" }, { id: "cs_2" }] });
    routes["POST /checkout/sessions/cs_1/expire"] = () => ({ id: "cs_1", status: "expired" });
    routes["POST /checkout/sessions/cs_2/expire"] = () => ({ id: "cs_2", status: "expired" });
    expect((await operate({ action: "comp", email: "producer@example.com" })).status).toBe(200);
    expect(paramsOf(calls, "GET /checkout/sessions")).toEqual([{ customer: "cus_1", status: "open", limit: "100" }]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/checkout/sessions/cs_1/expire", "/checkout/sessions/cs_2/expire"]);
    expect(await memberRow(user.id)).toMatchObject({ comp: 1 });
  });

  test("comp refunds and cancels a subscription that went live after its first look at Stripe", async () => {
    const user = await signedIn();
    await customer(user.id);
    paidInvoices();
    const live = subscription({ status: "active", member: user.id });
    let lists = 0;
    routes["GET /subscriptions"] = () => ({ data: lists++ ? [live] : [] });
    // The Checkout completes after comp's list, so it is no longer open, and its first apply grants paid access.
    routes["GET /checkout/sessions"] = async () => {
      await apply(live);
      return { data: [] };
    };
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: user.id });
    expect((await operate({ action: "comp", email: "producer@example.com" })).status).toBe(200);
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_1" }]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
    expect(await memberRow(user.id)).toMatchObject({ allowance: 8_000_000, comp: 1 });
  });

  test("uncomp ends access now, and refuses an account that is not comped", async () => {
    const user = await signedIn();
    await operate({ action: "comp", email: "producer@example.com" });
    expect((await operate({ action: "uncomp", member_id: user.id })).status).toBe(200);
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "plan_required", comp: false });
    expect((await operate({ action: "uncomp", member_id: user.id })).status).toBe(404);
  });

  test("maintenance renews an ended comp period and starts spending again", async () => {
    await env.DB.prepare("INSERT INTO members(id, allowance, spent, period_end, created_at, comp) VALUES ('c1', 8000000, 7000000, ?, 0, 1)")
      .bind(Date.now() - 1000).run();
    await env.DB.prepare("INSERT INTO members(id, allowance, spent, period_end, created_at) VALUES ('p1', 5000000, 4000000, ?, 0)")
      .bind(Date.now() - 1000).run();
    await maintain(on);
    expect(await memberRow("c1")).toMatchObject({ spent: 0 });
    expect((await memberRow("c1"))!.period_end).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(await memberRow("p1")).toMatchObject({ spent: 4_000_000 });
  });

  const listed = (data: unknown[]) => () => ({ data });
  const HOUR = 60 * 60_000;

  test("maintenance renews a subscription whose webhook never came", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = listed([subscription({ status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 })]);
    await maintain(on);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * 1000);
    expect(paramsOf(calls, "GET /subscriptions")).toEqual([{ customer: "cus_1", status: "all", limit: "10", "expand[0]": "data.latest_invoice" }]);
  });

  test("a renewal whose invoice.paid was lost is granted by renewals once Stripe shows it paid", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const renewal = { status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 };
    routes["GET /subscriptions"] = listed([subscription({ ...renewal, latest_invoice: { status: "open" } })]);
    await maintain(on);
    expect(await subRow()).toMatchObject({ current_period_end: (t - 7200) * S });
    expect(await memberRow()).toMatchObject({ spent: 1_500_000 });
    routes["GET /subscriptions"] = listed([subscription(renewal)]);
    await renewals(on, Date.now() + HOUR);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, spent: 0, period_end: (t + 30 * 86_400) * S });
    expect(await subRow()).toMatchObject({ current_period_end: (t + 30 * 86_400) * S });
  });

  test("an unpaid subscription past its period is re-read, so a cancel whose webhook was lost is applied", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    await apply(subscription({ status: "unpaid", member: "m1", start: t - 7200, end: t + 30 * 86_400, latest_invoice: { status: "open" } }));
    expect(await subRow()).toMatchObject({ status: "unpaid", current_period_end: (t - 7200) * S });
    routes["GET /subscriptions"] = listed([subscription({ status: "canceled", member: "m1", end: t - 7200 })]);
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "canceled" });
  });

  test("a Checkout whose first webhook was lost is applied within the session's life, and an older sign-up is not read", async () => {
    const t = Math.floor(Date.now() / 1000);
    await customer("m1", "cus_1");
    await customer("m2", "cus_2");
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = 'm1'").bind(Date.now() - 25 * HOUR).run();
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = 'm2'").bind(Date.now() - 27 * HOUR).run();
    routes["GET /subscriptions"] = listed([subscription({ status: "trialing", member: "m1", trial_end: t + 7 * 86_400 })]);
    await maintain(on);
    expect(paramsOf(calls, "GET /subscriptions").map((p) => p.customer)).toEqual(["cus_1"]);
    expect(await subRow()).toMatchObject({ status: "trialing", stripe_subscription_id: "sub_1" });
    expect(await memberRow()).toMatchObject({ allowance: 1_000_000 });
  });

  test("a subscription that ended under an hour ago waits for its webhook", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 60 }));
    await maintain(on);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  test("renewals read each row from Stripe at most once an hour, even when the read fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = () => new Response("down", { status: 500 });
    await maintain(on);
    await maintain(on);
    await renewals(on, Date.now() + 59 * 60_000);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(1);
    await renewals(on, Date.now() + HOUR + 1000);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(2);
    expect(events(logged).filter((e) => e.event === "renewal_sync_failed")).toEqual([
      { event: "renewal_sync_failed", member_id: "m1", subscription: "sub_1" },
      { event: "renewal_sync_failed", member_id: "m1", subscription: "sub_1" }]);
  });

  test("one failing renewal does not stop the next", async () => {
    await customer("m1", "cus_1");
    await customer("m2", "cus_2");
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    await apply(subscription({ id: "sub_2", customer: "cus_2", status: "active", member: "m2", end: t - 7200 }));
    routes["GET /subscriptions"] = (params) => params.get("customer") === "cus_1" ? new Response("down", { status: 500 })
      : { data: [subscription({ id: "sub_2", customer: "cus_2", status: "active", member: "m2", end: t + 86_400 })] };
    await maintain(on);
    expect((await memberRow("m2"))!.period_end).toBe((t + 86_400) * 1000);
  });

  test("stuck subscriptions do not crowd out a newly late renewal: each waits an hour after its read", async () => {
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
        VALUES (?, ?, ?, 'active', ?, 0)`).bind(`s${i}`, `cus_s${i}`, `sub_s${i}`, (t - 10 * 86_400) * 1000).run();
      routes[`GET /customers/cus_s${i}`] = () => ({ id: `cus_s${i}`, object: "customer", deleted: true });
    }
    await customer();
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = (params) => params.get("customer") === "cus_1"
      ? { data: [subscription({ status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 })] } : missing();
    await maintain(on);
    await maintain(on);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * 1000);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(21);
  });

  test("billing-sync applies Stripe's state now", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "past_due", member: "m1" })] });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "past_due" });
  });

  test("billing-sync applies a cancel of the row's own subscription whose webhook was lost", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: "m1" })] });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "canceled" });
  });

  test("a returning subscriber's Checkout whose first webhook was lost is applied, though the row shows the old cancel", async () => {
    await customer();
    await apply(subscription({ status: "canceled", member: "m1" }));
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = 'm1'").bind(Date.now() - 25 * HOUR).run();
    const t = Math.floor(Date.now() / 1000);
    routes["GET /subscriptions"] = listed([subscription({ id: "sub_2", status: "active", member: "m1", end: t + 30 * 86_400 }),
      subscription({ status: "canceled", member: "m1" })]);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "active", stripe_subscription_id: "sub_2" });
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, period_end: (t + 30 * 86_400) * S });
  });

  test("an ended row is read for a day after its last change, and not after", async () => {
    await customer();
    await apply(subscription({ status: "canceled", member: "m1" }));
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = 'm1'").bind(Date.now() - 25 * HOUR).run();
    routes["GET /subscriptions"] = listed([subscription({ status: "canceled", member: "m1" })]);
    await maintain(on);
    await renewals(on, Date.now() + 2 * HOUR);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(1);
  });

  test("a lapsed row whose customer Stripe deleted is marked canceled, read for a day after, and not after", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE member_id = 'm1'").bind(Date.now() - 27 * HOUR).run();
    routes["GET /subscriptions"] = missing;
    routes["GET /customers/cus_1"] = () => ({ id: "cus_1", object: "customer", deleted: true });
    const before = Date.now();
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "canceled" });
    expect((await subRow())!.updated_at).toBeGreaterThanOrEqual(before);
    await renewals(on, Date.now() + 2 * HOUR);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(2);
    await renewals(on, Date.now() + 27 * HOUR);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(2);
  });

  test("a list Stripe cannot find for a customer it still has, as with a wrong key, marks nothing and is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = missing;
    routes["GET /customers/cus_1"] = () => ({ id: "cus_1", object: "customer" });
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "active" });
    expect(events(logged)).toContainEqual({ event: "stripe_customer_lookup_mismatch", member_id: "m1", customer: "cus_1" });
  });

  test("a customer Stripe cannot find at all, as with a key from the other mode, marks nothing and is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = missing;
    routes["GET /customers/cus_1"] = missing;
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "active" });
    expect(events(logged)).toContainEqual({ event: "stripe_customer_lookup_mismatch", member_id: "m1", customer: "cus_1" });
  });

  test("a billable row with no period, as recreated after a restore, is read", async () => {
    await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, stripe_subscription_id, status, updated_at)
      VALUES ('m1', 'cus_1', 'sub_1', 'past_due', 0)`).run();
    routes["GET /subscriptions"] = listed([subscription({ status: "active", member: "m1" })]);
    await maintain(on);
    expect(await subRow()).toMatchObject({ status: "active" });
  });

  test("two overlapping renewals runs read a row once", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await apply(subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions"] = listed([subscription({ status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 })]);
    const now = Date.now();
    await Promise.all([renewals(on, now), renewals(on, now + 5)]);
    expect(calls.filter((c) => c.path === "/subscriptions")).toHaveLength(1);
  });

  test("billing-sync for a member whose row a restore lost finds the customer at Stripe and applies its subscription", async () => {
    await user("m1");
    routes["GET /customers/search"] = () => ({ data: [{ id: "cus_1" }] });
    routes["GET /subscriptions"] = listed([subscription({ status: "active", member: "m1" })]);
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "active" });
    expect(paramsOf(calls, "GET /customers/search")).toEqual([{ query: "metadata['member_id']:'m1'" }]);
    expect(await subRow()).toMatchObject({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" });
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("billing-sync for a member Stripe has no customer for says so, and makes none", async () => {
    await user("m1");
    routes["GET /customers/search"] = () => ({ data: [] });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "no_customer" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /customers/search"]);
    expect(await subRow()).toBeNull();
  });

  test("billing-sync for a member Stripe has a customer for but whose account is gone says so, and stores nothing", async () => {
    routes["GET /customers/search"] = () => ({ data: [{ id: "cus_1" }] });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "no_account" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /customers/search"]);
    expect(await subRow()).toBeNull();
  });

  test("billing-sync finds a subscription our row never recorded", async () => {
    await customer();
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "active" });
    expect(paramsOf(calls, "GET /subscriptions")).toEqual([{ customer: "cus_1", status: "all", limit: "10", "expand[0]": "data.latest_invoice" }]);
  });

  test("an abandoned sign-up is removed after 90 days, but one with a subscription is kept", async () => {
    const old = new Date(Date.now() - 91 * DAY).toISOString();
    for (const [id, status] of [["u1", "none"], ["u2", "canceled"]]) {
      await env.DB.prepare(`INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, '', ?, 1, ?, ?)`)
        .bind(id, `${id}@example.com`, old, old).run();
      await env.DB.prepare("INSERT INTO subscriptions(member_id, stripe_customer_id, status, updated_at) VALUES (?, ?, ?, 0)")
        .bind(id, `cus_${id}`, status).run();
    }
    await maintain(on);
    expect(await env.DB.prepare('SELECT id FROM "user" ORDER BY id').all()).toMatchObject({ results: [{ id: "u2" }] });
    expect(await subRow("u1")).toBeNull();
  });
});

describe("account deletion", () => {
  async function deleted(memberId: string) {
    await env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES (?, ?)").bind(memberId, Date.now() - 11 * 60_000).run();
    await env.DB.prepare("UPDATE members SET revoked = 1, deleted_at = ? WHERE id = ?").bind(Date.now(), memberId).run();
  }
  const job = (id: string) => env.DB.prepare("SELECT completed_at FROM deletion_jobs WHERE member_id = ?").bind(id).first<{ completed_at: number | null }>();
  beforeEach(() => {
    routes["GET /checkout/sessions"] = () => ({ data: [] });
  });

  test("the sweep expires open Checkout sessions first, then cancels every subscription that can still charge", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /checkout/sessions"] = () => ({ data: [{ id: "cs_1" }] });
    routes["POST /checkout/sessions/cs_1/expire"] = () => ({ id: "cs_1", status: "expired" });
    const listed = ["unpaid", "paused", "incomplete", "canceled", "incomplete_expired"].map((status) => subscription({ id: `sub_${status}`, status, member: "m1" }));
    routes["GET /subscriptions"] = () => ({ data: listed });
    for (const sub of listed) routes[`DELETE /subscriptions/${sub.id}`] = () => ({ ...sub, status: "canceled" });
    await maintain(on);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /checkout/sessions", "POST /checkout/sessions/cs_1/expire", "GET /subscriptions",
      "DELETE /subscriptions/sub_unpaid", "DELETE /subscriptions/sub_paused", "DELETE /subscriptions/sub_incomplete"]);
    expect(paramsOf(calls, "GET /checkout/sessions")).toEqual([{ customer: "cus_1", status: "open", limit: "100" }]);
    expect(paramsOf(calls, "GET /subscriptions")).toEqual([{ customer: "cus_1", status: "all", limit: "10", "expand[0]": "data.latest_invoice" }]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("the next sweep cancels a live subscription at Stripe, with no refund, and removes the row", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await maintain(on);
    expect(paramsOf(calls, "GET /subscriptions")).toEqual([{ customer: "cus_1", status: "all", limit: "10", "expand[0]": "data.latest_invoice" }]);
    const cancel = calls.find((c) => c.method === "DELETE")!;
    expect(cancel.path).toBe("/subscriptions/sub_1");
    expect(cancel.params.has("prorate")).toBe(false);
    expect(await subRow()).toBeNull();
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("a payment taken after the request is refunded when the sweep cancels before its webhook applies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    paidInvoices();
    // A renewal charged a minute after the request. Its invoice.paid delivery failed once; Stripe retries it later.
    const paidAt = Math.floor((Date.now() - 10 * 60_000) / 1000);
    const renewal = { id: "in_renewal", created: paidAt - 3600, status_transitions: { paid_at: paidAt } };
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1", latest_invoice: renewal })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1", latest_invoice: renewal });
    await maintain(on);
    // Stripe's retry now reads a canceled subscription.
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1", latest_invoice: renewal });
    await syncSubscription(on, "sub_1");
    expect(paramsOf(calls, "POST /refunds")).toEqual([{ payment_intent: "pi_in_renewal" }]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_1"]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("a payment taken before the request is canceled with no refund", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    const paidAt = Math.floor((Date.now() - 20 * 60_000) / 1000);
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1",
      latest_invoice: { id: "in_1", created: paidAt, status_transitions: { paid_at: paidAt } } })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await maintain(on);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /checkout/sessions", "GET /subscriptions", "DELETE /subscriptions/sub_1"]);
    expect(events(logged)).toContainEqual({ event: "subscription_canceled_for_deletion", subscription: "sub_1" });
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("a deletion that commits while a first payment's apply waits at its batch leaves no live member", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await user("m1");
    await customer();
    // Paid just before the deletion, as in the race. The sweep below needs the request backdated past its 10 minutes.
    const paidAt = Math.floor((Date.now() - 12 * 60_000) / 1000);
    const sub = subscription({ status: "active", member: "m1",
      latest_invoice: { id: "in_1", created: paidAt, status_transitions: { paid_at: paidAt } } });
    const slow = gated();
    const applying = applySubscription(slow.env, sub as StripeSubscription, read());
    await slow.atBatch;
    // Open sign-up: the account has no members row yet, so only the job records the deletion.
    await deleteAccount(on, "m1", false);
    slow.open();
    await applying;
    await env.DB.prepare("UPDATE deletion_jobs SET requested_at = ? WHERE member_id = 'm1'").bind(Date.now() - 11 * 60_000).run();
    routes["GET /subscriptions"] = () => ({ data: [sub] });
    routes["DELETE /subscriptions/sub_1"] = () => ({ ...sub, status: "canceled" });
    await maintain(on);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /checkout/sessions", "GET /subscriptions", "DELETE /subscriptions/sub_1"]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE id = 'm1' AND deleted_at IS NULL").first()).toEqual({ n: 0 });
  });

  test("a deletion cancel that finds no pending request cancels nothing, and fails so the sweep retries", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    expect(await cancelForDeletion(on, "m1")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(events(logged)).toContainEqual({ event: "deletion_cancel_failed", member_id: "m1" });
  });

  test("when Stripe is down, the deletion waits and retries", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => new Response("down", { status: 500 });
    await maintain(on);
    expect((await job("m1"))!.completed_at).toBeNull();
    expect(await subRow()).not.toBeNull();
  });

  test("a customer Stripe no longer has holds nothing to cancel, so the deletion completes", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /checkout/sessions"] = missing;
    routes["GET /subscriptions"] = missing;
    await maintain(on);
    expect((await job("m1"))!.completed_at).not.toBeNull();
    expect(await subRow()).toBeNull();
  });

  test("a subscription Stripe already canceled is not canceled again", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "canceled", member: "m1" })] });
    await maintain(on);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("a live subscription whose webhook never arrived is still canceled", async () => {
    await customer();
    await env.DB.prepare("INSERT INTO members(id, period_end, created_at) VALUES ('m1', 0, 0)").run();
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ id: "sub_9", status: "active", member: "m1" })] });
    routes["DELETE /subscriptions/sub_9"] = () => subscription({ id: "sub_9", status: "canceled", member: "m1" });
    await maintain(on);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/subscriptions/sub_9"]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("the subscription is canceled even while shared-content cleanup is unfinished", async () => {
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    await env.DB.prepare(`INSERT INTO support_reports(id, user_id, object_key, state, created_at, updated_at)
      VALUES ('r1', 'm1', 'reports/r1', 'deleting', 0, 0)`).run();
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    // The report's object cannot be deleted, so its cleanup stays unfinished.
    const stuck = { delete: async () => { throw new Error("r2 down"); }, list: (o: R2ListOptions) => env.CAPTURE.list(o) };
    await maintain({ ...on, CAPTURE: stuck } as unknown as Env);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/subscriptions/sub_1")).toBe(true);
    expect((await job("m1"))!.completed_at).toBeNull();
  });

  test("deletions whose Stripe cancel keeps failing do not hold up a newer one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 25; i++) {
      await customer(`s${i}`, `cus_s${i}`);
      await env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES (?, ?)").bind(`s${i}`, Date.now() - DAY).run();
    }
    await customer();
    // Not yet due for the 90-day sign-up cleanup, nor for the renewals read of a recent Checkout.
    await env.DB.prepare("UPDATE subscriptions SET updated_at = ?").bind(Date.now() - 27 * 60 * 60_000).run();
    await deleted("m1");
    routes["GET /checkout/sessions"] = (params) => params.get("customer") === "cus_1" ? { data: [] } : new Response("down", { status: 500 });
    routes["GET /subscriptions"] = () => ({ data: [] });
    await maintain(on);
    await maintain(on);
    expect((await job("m1"))!.completed_at).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deletion_jobs WHERE completed_at IS NULL AND billing_cleared_at IS NULL").first())
      .toEqual({ n: 25 });
  });

  test("two overlapping sweeps cancel a deletion's subscription once", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await Promise.all([maintain(on), maintain(on)]);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(events(logged).filter((e) => e.event === "deletion_cancel_failed")).toEqual([]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("a sweep that starts while another is inside its Stripe calls skips the job", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await customer();
    await apply(subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    let late = false;
    routes["DELETE /subscriptions/sub_1"] = async () => {
      // The second sweep runs entirely after the first one's claim, while its DELETE is pending.
      if (!late) { late = true; await maintain(on); }
      return subscription({ status: "canceled", member: "m1" });
    };
    await maintain(on);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(events(logged).filter((e) => e.event === "deletion_cancel_failed")).toEqual([]);
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("events after deletion are acknowledged and change nothing", async () => {
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    const body = JSON.stringify({ id: "evt_9", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
    const response = await worker.fetch(new Request("http://localhost:8787/webhooks/stripe", { method: "POST",
      headers: { "Stripe-Signature": await sign(body) }, body }), on as never, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await memberRow()).toBeNull();
  });
});
