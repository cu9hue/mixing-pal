import { vi } from "vitest";

export interface StripeCall { method: string; path: string; params: URLSearchParams; headers: Headers }
export type StripeRoutes = Record<string, (params: URLSearchParams) => unknown>;

/** Stubs Resend and Stripe. Stripe routes are keyed "METHOD /path" without the /v1 prefix. */
export function stubNetwork(routes: StripeRoutes, calls: StripeCall[], onEmail?: (text: string) => void) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === "https://api.resend.com/emails") {
      onEmail?.(JSON.parse(String(init?.body)).text);
      return Response.json({ id: "email-id" });
    }
    if (url.origin === "https://api.stripe.com") {
      const method = init?.method ?? "GET";
      const params = new URLSearchParams(method === "GET" ? url.search : String(init?.body ?? ""));
      const path = url.pathname.replace(/^\/v1/, "");
      calls.push({ method, path, params, headers: new Headers(init?.headers) });
      const route = routes[`${method} ${path}`];
      if (!route) return Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
      const result = route(params);
      return result instanceof Response ? result : Response.json(result);
    }
    throw new Error(`Unexpected network request: ${url.href}`);
  });
}

/** A subscription shaped as API version 2026-09-30.endive returns it. Times are seconds. */
export function subscription(o: { id?: string; status?: string; price?: string; member?: string; customer?: string;
  start?: number; end?: number; trial_end?: number | null; cancel_at_period_end?: boolean; pending_update?: unknown } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { id: o.id ?? "sub_1", object: "subscription", customer: o.customer ?? "cus_1", status: o.status ?? "active",
    cancel_at_period_end: o.cancel_at_period_end ?? false, trial_end: o.trial_end ?? null,
    metadata: o.member === undefined ? {} : { member_id: o.member }, pending_update: o.pending_update ?? null,
    items: { data: [{ id: "si_1", price: { id: o.price ?? "price_starter" },
      current_period_start: o.start ?? now, current_period_end: o.end ?? now + 30 * 86_400 }] } };
}

/** Signs a body the way Stripe does: HMAC-SHA256 of "t.body", keyed by the whole whsec_ secret, hex. */
export async function sign(body: string, secret = "whsec_test", t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
