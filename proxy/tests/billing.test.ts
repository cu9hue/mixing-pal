import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { DAY, Env } from "../src/env";
import { applySubscription } from "../src/subscriptions";
import { StripeCall, StripeRoutes, sign, stubNetwork, subscription } from "./stripe-fixtures";

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
    await applySubscription(on, subscription({ status: "trialing", member: "m1", trial_end: t + 7 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 1_000_000, spent: 0, period_end: (t + 7 * 86_400) * S });
    expect(await subRow()).toMatchObject({ status: "trialing", plan: "starter", trial_used: 1, stripe_subscription_id: "sub_1" });
  });

  test("the first paid period after a trial gives the tier's allowance and starts spending again", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    await env.DB.prepare("UPDATE members SET spent = 900000 WHERE id = 'm1'").run();
    await applySubscription(on, subscription({ status: "active", member: "m1", price: "price_pro", start: t, end: t + 30 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, spent: 0, period_end: (t + 30 * 86_400) * S });
  });

  test("an upgrade in the same period raises the allowance and keeps what she spent", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    await applySubscription(on, subscription({ status: "active", member: "m1", price: "price_pro", end: t + 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, spent: 1_500_000 });
  });

  test("a renewal starts spending again, and the same state applied twice changes nothing more", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const renewed = subscription({ status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 });
    await applySubscription(on, renewed, now);
    await env.DB.prepare("UPDATE members SET spent = 400000 WHERE id = 'm1'").run();
    await applySubscription(on, renewed, now);
    expect(await memberRow()).toMatchObject({ spent: 400_000, period_end: (t + 31 * 86_400) * S });
  });

  test("a renewal keeps money held for requests in flight", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000, reserved = 310000 WHERE id = 'm1'").run();
    await applySubscription(on, subscription({ status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ spent: 0, reserved: 310_000 });
  });

  test("a failed payment keeps access for seven days past the paid period", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t }), now);
    await applySubscription(on, subscription({ status: "past_due", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, period_end: t * S + 7 * DAY });
  });

  test("a canceled subscription ends access now and never extends an earlier end", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await applySubscription(on, subscription({ status: "canceled", member: "m1" }), now);
    expect((await memberRow())!.period_end).toBe(now);
    await applySubscription(on, subscription({ status: "canceled", member: "m1" }), now + 5000);
    expect((await memberRow())!.period_end).toBe(now);
  });

  test("an incomplete first payment grants nothing", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "incomplete", member: "m1" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "incomplete" });
  });

  test("a subscription for an unknown account or customer writes nothing", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "nobody" }), now);
    await applySubscription(on, subscription({ status: "active", member: "m1", customer: "cus_other" }), now);
    await applySubscription(on, subscription({ status: "active" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "none" });
  });

  test("an unknown price writes nothing", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", price: "price_other" }), now);
    expect(await memberRow()).toBeNull();
  });

  test("a second live subscription is canceled at Stripe and changes nothing here", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }), now);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1" });
    routes["DELETE /subscriptions/sub_2"] = () => subscription({ id: "sub_2", status: "canceled", member: "m1" });
    await applySubscription(on, subscription({ id: "sub_2", status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /subscriptions/sub_1", "DELETE /subscriptions/sub_2"]);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_1", plan: "starter" });
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000 });
  });

  test("a new subscription replaces one Stripe already canceled, even before its webhook arrives", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }), now);
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await applySubscription(on, subscription({ id: "sub_2", status: "active", member: "m1", price: "price_pro" }), now);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(await subRow()).toMatchObject({ stripe_subscription_id: "sub_2", plan: "pro" });
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000 });
  });

  test("an old subscription ending does not touch the current one", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await applySubscription(on, subscription({ id: "sub_0", status: "canceled", member: "m1" }), now);
    expect(await memberRow()).toMatchObject({ period_end: (t + 86_400) * S });
  });

  test("a comped account is left alone", async () => {
    await customer();
    await env.DB.prepare("INSERT INTO members(id, allowance, period_end, created_at, comp) VALUES ('m1', 8000000, ?, 0, 1)").bind(now + DAY).run();
    await applySubscription(on, subscription({ status: "active", member: "m1" }), now);
    await applySubscription(on, subscription({ status: "canceled", member: "m1" }), now);
    expect(await memberRow()).toMatchObject({ allowance: 8_000_000, period_end: now + DAY, comp: 1 });
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
