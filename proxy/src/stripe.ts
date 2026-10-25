import { ApiError, Env, privateHash } from "./env";

// Field paths in subscriptions.ts are this version's: the period sits on
// subscription items, and an invoice names its subscription under parent.
export const STRIPE_VERSION = "2026-09-30.endive";
const API = "https://api.stripe.com/v1";
// Stripe's own libraries default to five minutes.
const TOLERANCE_S = 300;
const UNAVAILABLE = "Billing is unavailable. Try again in a minute.";

/** Stripe's form encoding: nested keys as a[b][0][c]. */
export function encode(value: unknown, key = "", out: string[] = []): string[] {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) value.forEach((item, i) => encode(item, `${key}[${i}]`, out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) encode(v, key ? `${key}[${k}]` : k, out);
  else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return out;
}

export async function stripe<T>(env: Env, method: "GET" | "POST" | "DELETE", path: string,
  params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new ApiError(503, "billing_unavailable", UNAVAILABLE);
  const query = params ? encode(params).join("&") : "";
  // The resource name only: ids and messages stay out of the logs.
  const resource = path.split("/")[1];
  let response: Response;
  try {
    response = await fetch(method === "GET" && query ? `${API}${path}?${query}` : `${API}${path}`, { method,
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION,
        ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: method === "GET" ? undefined : query, signal: AbortSignal.timeout(10_000) });
  } catch {
    console.error(JSON.stringify({ event: "stripe_unreachable", resource }));
    throw new ApiError(503, "billing_unavailable", UNAVAILABLE);
  }
  if (!response.ok) {
    const failure = await response.json<{ error?: { type?: string; code?: string } }>().catch(() => null);
    console.error(JSON.stringify({ event: "stripe_failed", resource, status: response.status, code: failure?.error?.code ?? null }));
    if (failure?.error?.type === "card_error") throw new ApiError(402, "card_declined", "Your card was declined. Update it in Manage subscription.");
    // Permanent, unlike an outage: callers that can treat it as nothing there must be able to tell.
    if (failure?.error?.code === "resource_missing") throw new ApiError(404, "stripe_not_found", "Billing record not found.");
    throw new ApiError(503, "billing_unavailable", UNAVAILABLE);
  }
  return response.json<T>();
}

/** Stripe's manual check: v1 signatures only, HMAC-SHA256 over "t.body", constant-time compare. */
export async function verifySignature(secret: string, header: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const pairs = header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  });
  const t = Number(pairs.find(([k]) => k === "t")?.[1]);
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = await privateHash(secret, `${t}.${body}`);
  return signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    return difference === 0;
  });
}
