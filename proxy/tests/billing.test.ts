import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { DAY, Env } from "../src/env";
import { maintain } from "../src/maintenance";
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

  test("a renewal whose invoice is not paid yet keeps spending and the allowance, with seven days of access", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t + 86_400 }), now);
    await env.DB.prepare("UPDATE members SET spent = 1500000 WHERE id = 'm1'").run();
    const renewal = { status: "active", member: "m1", start: t + 86_400, end: t + 31 * 86_400 };
    await applySubscription(on, subscription({ ...renewal, latest_invoice: { status: "draft" } }), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, spent: 1_500_000, period_end: (t + 86_400) * S + 7 * DAY });
    await applySubscription(on, subscription(renewal), now);
    expect(await memberRow()).toMatchObject({ allowance: 2_000_000, spent: 0, period_end: (t + 31 * 86_400) * S });
  });

  test("a trial that ends before its first charge keeps the trial's allowance and spending", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "trialing", member: "m1", price: "price_pro", trial_end: t + 60 }), now);
    await env.DB.prepare("UPDATE members SET spent = 900000 WHERE id = 'm1'").run();
    await applySubscription(on, subscription({ status: "active", member: "m1", price: "price_pro", start: t + 60, end: t + 60 + 30 * 86_400,
      latest_invoice: { status: "open" } }), now);
    expect(await memberRow()).toMatchObject({ allowance: 1_000_000, spent: 900_000, period_end: (t + 60) * S + 7 * DAY });
  });

  test("an unpaid invoice creates no member", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", latest_invoice: "in_1" }), now);
    expect(await memberRow()).toBeNull();
  });

  test("a failed payment never shortens access", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    await applySubscription(on, subscription({ status: "past_due", member: "m1", start: t, end: t + 30 * 86_400 }), now);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * S);
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

  test("an unknown price on a live subscription fails so it is retried, and writes nothing", async () => {
    await customer();
    await expect(applySubscription(on, subscription({ status: "active", member: "m1", price: "price_other" }), now)).rejects.toThrow();
    await applySubscription(on, subscription({ status: "canceled", member: "m1", price: "price_other" }), now);
    expect(await memberRow()).toBeNull();
    expect(await subRow()).toMatchObject({ status: "none" });
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
    await applySubscription(on, subscription({ status: "trialing", member: user.id, trial_end: t + 86_400, cancel_at_period_end: true }));
    expect(await (await api("/v1/account", undefined, user.token)).json())
      .toMatchObject({ access: "active", subscription_status: "trialing", cancel_at_period_end: true, manage: true });
    await applySubscription(on, subscription({ status: "canceled", member: user.id }));
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ access: "plan_required", trial_available: false });
  });

  test("an active subscription shows its plan", async () => {
    const user = await signedIn();
    await customer(user.id);
    await applySubscription(on, subscription({ status: "active", member: user.id, price: "price_pro" }));
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
  });
  const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

  test("a new account's checkout creates one customer and a session with a 7-day trial", async () => {
    const user = await signedIn();
    const response = await api("/v1/billing/checkout", { plan: "pro" }, user.token);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(posted("/customers")[0].params.get("metadata[member_id]")).toBe(user.id);
    expect(posted("/customers")[0].headers.get("Idempotency-Key")).toBe(`customer-${user.id}`);
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
    await applySubscription(on, subscription({ status: "active", member: user.id }));
    expect(await (await api("/v1/billing/checkout", { plan: "pro" }, user.token)).json()).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(posted("/checkout/sessions")).toHaveLength(0);
  });

  test("a subscription Stripe has but our webhook hasn't delivered still gets the Portal", async () => {
    const user = await signedIn();
    await customer(user.id);
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: user.id })] });
    expect(await (await api("/v1/billing/checkout", { plan: "pro" }, user.token)).json()).toEqual({ url: "https://billing.stripe.com/p/session/1" });
    expect(posted("/checkout/sessions")).toHaveLength(0);
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
    await applySubscription(on, subscription({ status: "active", member: user.id }));
    expect((await api("/v1/billing/portal", {}, user.token)).status).toBe(200);
    expect(posted("/billing_portal/sessions")[0].params.get("return_url")).toBe("http://localhost:8787/billing/done?state=portal");
  });

  test("start-now ends the trial at Stripe and gives the tier's allowance at once", async () => {
    const user = await signedIn();
    await customer(user.id);
    const t = Math.floor(Date.now() / 1000);
    await applySubscription(on, subscription({ status: "trialing", member: user.id, price: "price_pro", trial_end: t + 86_400 }));
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, price: "price_pro", start: t, end: t + 30 * 86_400 });
    const view = await (await api("/v1/billing/start-now", {}, user.token)).json();
    expect(posted("/subscriptions/sub_1")[0].params.get("trial_end")).toBe("now");
    expect(posted("/subscriptions/sub_1")[0].params.get("expand[0]")).toBe("latest_invoice");
    expect(view).toMatchObject({ access: "active", subscription_status: "active", remaining_micro_usd: 8_000_000 });
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
    await applySubscription(on, subscription({ status: "active", member: user.id, end }));
    await env.DB.prepare("UPDATE members SET spent = 1800000 WHERE id = ?").bind(user.id).run();
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end });
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, price: "price_pro", end });
    const view = await (await api("/v1/billing/upgrade", {}, user.token)).json();
    expect(Object.fromEntries(posted("/subscriptions/sub_1")[0].params)).toMatchObject({ "items[0][id]": "si_1",
      "items[0][price]": "price_pro", proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete",
      "expand[0]": "latest_invoice" });
    expect(view).toMatchObject({ plan: "pro", remaining_micro_usd: 6_200_000 });
  });

  test("a declined upgrade leaves Starter in place and says the card was declined", async () => {
    const user = await signedIn();
    await customer(user.id);
    const end = Math.floor(Date.now() / 1000) + 86_400;
    await applySubscription(on, subscription({ status: "active", member: user.id, end }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end });
    routes["POST /subscriptions/sub_1"] = () => subscription({ status: "active", member: user.id, end, pending_update: { expires_at: 1 } });
    const response = await api("/v1/billing/upgrade", {}, user.token);
    expect(response.status).toBe(402);
    expect(await memberRow(user.id)).toMatchObject({ allowance: 2_000_000 });
  });

  test("only an active Starter plan can upgrade", async () => {
    const user = await signedIn();
    await customer(user.id);
    await applySubscription(on, subscription({ status: "active", member: user.id, price: "price_pro" }));
    expect((await api("/v1/billing/upgrade", {}, user.token)).status).toBe(409);
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
    await applySubscription(on, subscription({ status: "active", member: user.id }));
    expect((await operate({ action: "comp", email: "producer@example.com" })).status).toBe(409);
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

  test("maintenance renews a subscription whose webhook never came", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 });
    await maintain(on);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * 1000);
  });

  test("a subscription that ended under an hour ago waits for its webhook", async () => {
    await customer();
    const t = Math.floor(Date.now() / 1000);
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t - 60 }));
    await maintain(on);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  test("one failing renewal does not stop the next", async () => {
    await customer("m1", "cus_1");
    await customer("m2", "cus_2");
    const t = Math.floor(Date.now() / 1000);
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t - 7200 }));
    await applySubscription(on, subscription({ id: "sub_2", customer: "cus_2", status: "active", member: "m2", end: t - 7200 }));
    routes["GET /subscriptions/sub_1"] = () => new Response("down", { status: 500 });
    routes["GET /subscriptions/sub_2"] = () => subscription({ id: "sub_2", customer: "cus_2", status: "active", member: "m2", end: t + 86_400 });
    await maintain(on);
    expect((await memberRow("m2"))!.period_end).toBe((t + 86_400) * 1000);
  });

  test("stuck subscriptions do not crowd out a newly late renewal", async () => {
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(`INSERT INTO subscriptions(member_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
        VALUES (?, ?, ?, 'active', ?, 0)`).bind(`s${i}`, `cus_s${i}`, `sub_s${i}`, (t - 10 * 86_400) * 1000).run();
    }
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1", end: t - 7200 }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "active", member: "m1", start: t - 7200, end: t + 30 * 86_400 });
    await maintain(on);
    expect((await memberRow())!.period_end).toBe((t + 30 * 86_400) * 1000);
  });

  test("billing-sync applies Stripe's state now", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "past_due", member: "m1" });
    expect(await (await operate({ action: "billing_sync", member_id: "m1" })).json()).toEqual({ status: "past_due" });
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

  test("the next sweep cancels a live subscription at Stripe, with no refund, and removes the row", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => ({ data: [subscription({ status: "active", member: "m1" })] });
    routes["DELETE /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    await maintain(on);
    const cancel = calls.find((c) => c.method === "DELETE")!;
    expect(cancel.path).toBe("/subscriptions/sub_1");
    expect(cancel.params.has("prorate")).toBe(false);
    expect(await subRow()).toBeNull();
    expect((await job("m1"))!.completed_at).not.toBeNull();
  });

  test("when Stripe is down, the deletion waits and retries", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => new Response("down", { status: 500 });
    await maintain(on);
    expect((await job("m1"))!.completed_at).toBeNull();
    expect(await subRow()).not.toBeNull();
  });

  test("a customer Stripe no longer has holds nothing to cancel, so the deletion completes", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
    await deleted("m1");
    routes["GET /subscriptions"] = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
    await maintain(on);
    expect((await job("m1"))!.completed_at).not.toBeNull();
    expect(await subRow()).toBeNull();
  });

  test("a subscription Stripe already canceled is not canceled again", async () => {
    await customer();
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
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
    await applySubscription(on, subscription({ status: "active", member: "m1" }));
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

  test("events after deletion are acknowledged and change nothing", async () => {
    routes["GET /subscriptions/sub_1"] = () => subscription({ status: "canceled", member: "m1" });
    const body = JSON.stringify({ id: "evt_9", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
    const response = await worker.fetch(new Request("http://localhost:8787/webhooks/stripe", { method: "POST",
      headers: { "Stripe-Signature": await sign(body) }, body }), on as never, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await memberRow()).toBeNull();
  });
});
