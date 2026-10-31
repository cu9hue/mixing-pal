import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, Env, readText } from "../src/env";
import { STRIPE_VERSION, encode, stripe, verifySignature } from "../src/stripe";
import { StripeCall, StripeRoutes, sign, stubNetwork, unrouted } from "./stripe-fixtures";

const live = env as unknown as Env;
let routes: StripeRoutes;
let calls: StripeCall[];
beforeEach(() => { routes = {}; calls = []; stubNetwork(routes, calls); });
afterEach(() => vi.restoreAllMocks());

describe("form encoding", () => {
  test("nests objects and arrays the way Stripe reads them", () => {
    const params = new URLSearchParams(encode({ mode: "subscription", line_items: [{ price: "price_pro", quantity: 1 }],
      subscription_data: { metadata: { member_id: "m1" }, trial_period_days: 7 }, automatic_tax: { enabled: true } }).join("&"));
    expect(Object.fromEntries(params)).toEqual({ mode: "subscription", "line_items[0][price]": "price_pro", "line_items[0][quantity]": "1",
      "subscription_data[metadata][member_id]": "m1", "subscription_data[trial_period_days]": "7", "automatic_tax[enabled]": "true" });
  });

  test("leaves out undefined and null values", () => {
    expect(encode({ a: undefined, b: null, c: "x" })).toEqual(["c=x"]);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });

  test("a signature made with the endpoint secret passes", async () => {
    expect(await verifySignature("whsec_test", await sign(body), body)).toBe(true);
  });

  test("a changed body fails", async () => {
    expect(await verifySignature("whsec_test", await sign(body), body.replace("evt_1", "evt_2"))).toBe(false);
  });

  test("a signature older than five minutes fails", async () => {
    const t = Math.floor(Date.now() / 1000) - 301;
    expect(await verifySignature("whsec_test", await sign(body, "whsec_test", t), body)).toBe(false);
  });

  test("any one of two v1 signatures passes, as during a secret roll", async () => {
    const t = Math.floor(Date.now() / 1000);
    const old = (await sign(body, "whsec_old", t)).split(",")[1];
    const current = await sign(body, "whsec_test", t);
    expect(await verifySignature("whsec_test", `${current},${old}`, body)).toBe(true);
    expect(await verifySignature("whsec_old", `${current},${old}`, body)).toBe(true);
  });

  test("a v0 signature is ignored, and a missing header fails", async () => {
    const v1 = await sign(body);
    expect(await verifySignature("whsec_test", v1.replace("v1=", "v0="), body)).toBe(false);
    expect(await verifySignature("whsec_test", null, body)).toBe(false);
  });
});

describe("the Stripe client", () => {
  test("sends the pinned version, the secret key and a form body", async () => {
    routes["POST /customers"] = () => ({ id: "cus_1" });
    expect(await stripe<{ id: string }>(live, "POST", "/customers", { metadata: { member_id: "m1" } }, "customer-m1")).toEqual({ id: "cus_1" });
    expect(calls[0].headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
    expect(calls[0].headers.get("Authorization")).toBe("Bearer sk_test_proxy");
    expect(calls[0].headers.get("Idempotency-Key")).toBe("customer-m1");
    expect(calls[0].params.get("metadata[member_id]")).toBe("m1");
  });

  test("an outage or a rate limit reads as billing_unavailable; a refusal as stripe_rejected, with the same copy", async () => {
    routes["GET /subscriptions/sub_1"] = () => new Response("down", { status: 500 });
    await expect(stripe(live, "GET", "/subscriptions/sub_1")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
    routes["GET /subscriptions/sub_3"] = () => Response.json({ error: { type: "invalid_request_error", code: "rate_limit" } }, { status: 429 });
    await expect(stripe(live, "GET", "/subscriptions/sub_3")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
    routes["GET /subscriptions/sub_2"] = () => Response.json({ error: { type: "invalid_request_error", code: "parameter_unknown" } }, { status: 400 });
    await expect(stripe(live, "GET", "/subscriptions/sub_2")).rejects.toMatchObject({ status: 503, code: "stripe_rejected",
      message: "Billing is unavailable. Try again in a minute." });
  });

  test("a record Stripe does not have reads as stripe_not_found", async () => {
    routes["GET /subscriptions/sub_1"] = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
    await expect(stripe(live, "GET", "/subscriptions/sub_1")).rejects.toMatchObject({ status: 404, code: "stripe_not_found" });
  });

  test("a declined card reads as card_declined", async () => {
    routes["POST /subscriptions/sub_1"] = () => Response.json({ error: { type: "card_error", code: "card_declined" } }, { status: 402 });
    await expect(stripe(live, "POST", "/subscriptions/sub_1", {})).rejects.toMatchObject({ status: 402, code: "card_declined" });
  });

  test("a refund Stripe already made reads as stripe_already_refunded", async () => {
    routes["POST /refunds"] = () => Response.json({ error: { type: "invalid_request_error", code: "charge_already_refunded" } }, { status: 400 });
    await expect(stripe(live, "POST", "/refunds", { payment_intent: "pi_1" })).rejects.toMatchObject({ code: "stripe_already_refunded" });
  });

  test("a refusal logs Stripe's type and param, and never its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    routes["POST /checkout/sessions"] = () => Response.json({ error: { type: "invalid_request_error", code: "parameter_unknown",
      param: "automatic_tax[enabled]", message: "Received unknown parameter for jane@example.com" } }, { status: 400 });
    await expect(stripe(live, "POST", "/checkout/sessions", {})).rejects.toMatchObject({ code: "stripe_rejected" });
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "stripe_failed", resource: "checkout",
      status: 400, code: "parameter_unknown", type: "invalid_request_error", param: "automatic_tax[enabled]" }]);
  });

  test("a key still in use by a call in flight is retried once, a second later", async () => {
    const inUse = () => Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use" } }, { status: 409 });
    let attempts = 0;
    routes["POST /customers"] = () => ++attempts === 1 ? inUse() : { id: "cus_1" };
    const started = Date.now();
    expect(await stripe(live, "POST", "/customers", {}, "customer-m1")).toEqual({ id: "cus_1" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(calls).toHaveLength(2);
    // Twice in use fails; without a key there is nothing to wait for.
    routes["POST /customers"] = inUse;
    await expect(stripe(live, "POST", "/customers", {}, "customer-m1")).rejects.toMatchObject({ code: "billing_unavailable" });
    await expect(stripe(live, "POST", "/customers", {})).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(calls).toHaveLength(5);
  });

  test("the stub records a call it has no route for, so the test fails even when the code reads it as an outage", async () => {
    await expect(stripe(live, "GET", "/subscriptions/sub_9")).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(unrouted.splice(0)).toEqual(["GET /subscriptions/sub_9"]);
  });

  test("no secret key means billing is unavailable, with no network call, and is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(stripe({ ...live, STRIPE_SECRET_KEY: undefined }, "GET", "/subscriptions/sub_1")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: "billing_not_configured" }]);
  });
});

test("readText returns the raw body", async () => {
  expect(await readText(new Request("http://x", { method: "POST", body: "{ \"a\": 1 }" }))).toBe("{ \"a\": 1 }");
});
