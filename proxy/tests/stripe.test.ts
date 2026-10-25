import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, Env, readText } from "../src/env";
import { STRIPE_VERSION, encode, stripe, verifySignature } from "../src/stripe";
import { StripeCall, StripeRoutes, sign, stubNetwork } from "./stripe-fixtures";

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
    const old = (await sign(body, "whsec_old")).split(",")[1];
    expect(await verifySignature("whsec_test", `${await sign(body)},${old}`, body)).toBe(true);
    expect(await verifySignature("whsec_old", `${await sign(body)},${old}`, body)).toBe(true);
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

  test("a Stripe outage or a refused call reads as billing_unavailable", async () => {
    routes["GET /subscriptions/sub_1"] = () => new Response("down", { status: 500 });
    await expect(stripe(live, "GET", "/subscriptions/sub_1")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
    await expect(stripe(live, "GET", "/subscriptions/missing")).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
  });

  test("a declined card reads as card_declined", async () => {
    routes["POST /subscriptions/sub_1"] = () => Response.json({ error: { type: "card_error", code: "card_declined" } }, { status: 402 });
    await expect(stripe(live, "POST", "/subscriptions/sub_1", {})).rejects.toMatchObject({ status: 402, code: "card_declined" });
  });

  test("no secret key means billing is unavailable, with no network call", async () => {
    await expect(stripe({ ...live, STRIPE_SECRET_KEY: undefined }, "GET", "/subscriptions/sub_1")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });
});

test("readText returns the raw body", async () => {
  expect(await readText(new Request("http://x", { method: "POST", body: "{ \"a\": 1 }" }))).toBe("{ \"a\": 1 }");
});
