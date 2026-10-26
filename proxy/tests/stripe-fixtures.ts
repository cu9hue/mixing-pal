import { vi } from "vitest";

export interface StripeCall { method: string; path: string; params: URLSearchParams; headers: Headers }
export type StripeRoutes = Record<string, (params: URLSearchParams) => unknown>;

/** Stripe calls with no route. setup.ts fails the test when any is left: stripe() reads the stub's throw as an outage. */
export const unrouted: string[] = [];

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
      // Never a default answer: a 404 would read as "nothing there" to the deletion code.
      if (!route) {
        unrouted.push(`${method} ${path}`);
        throw new Error(`Unexpected Stripe call: ${method} ${path}`);
      }
      const result = await route(params);
      return result instanceof Response ? result : Response.json(result);
    }
    throw new Error(`Unexpected network request: ${url.href}`);
  });
}

/** The params of each recorded call to one route, keyed "METHOD /path", as plain objects. */
export function paramsOf(calls: StripeCall[], route: string): Record<string, string>[] {
  return calls.filter((c) => `${c.method} ${c.path}` === route).map((c) => Object.fromEntries(c.params));
}

export const missing = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });

type Invoice = { id?: string; status?: string; amount_paid?: number; billing_reason?: string; created?: number;
  status_transitions?: { paid_at: number | null }; hosted_invoice_url?: string | null };

/** A subscription shaped as API version 2026-09-30.endive returns it. Times are seconds. */
export function subscription(o: { id?: string; status?: string; price?: string; member?: string; customer?: string;
  start?: number; end?: number; trial_end?: number | null; ended_at?: number | null; cancel_at_period_end?: boolean; pending_update?: unknown;
  latest_invoice?: string | Invoice | null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const status = o.status ?? "active";
  // A trial's first invoice is for $0. Any other paid invoice charged something, in cents.
  const invoice = { id: "in_1", status: "paid", amount_paid: status === "trialing" ? 0 : 800 };
  // Stripe ends a trialing subscription's period at the trial's end.
  const end = o.end ?? (status === "trialing" && o.trial_end ? o.trial_end : now + 30 * 86_400);
  return { id: o.id ?? "sub_1", object: "subscription", customer: o.customer ?? "cus_1", status,
    cancel_at_period_end: o.cancel_at_period_end ?? false, trial_end: o.trial_end ?? null, ended_at: o.ended_at ?? null,
    metadata: o.member === undefined ? {} : { member_id: o.member }, pending_update: o.pending_update ?? null,
    latest_invoice: o.latest_invoice === undefined ? invoice
      : typeof o.latest_invoice === "object" && o.latest_invoice ? { ...invoice, ...o.latest_invoice } : o.latest_invoice,
    items: { data: [{ id: "si_1", price: { id: o.price ?? "price_starter" },
      current_period_start: o.start ?? now, current_period_end: end }] } };
}

/** Signs a body the way Stripe does: HMAC-SHA256 of "t.body", keyed by the whole whsec_ secret, hex. */
export async function sign(body: string, secret = "whsec_test", t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
