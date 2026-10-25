import { ApiError, DAY, Env } from "./env";

export type Plan = "starter" | "pro";
// Model cost per period in micro-USD, like members.allowance.
export const ALLOWANCE: Record<Plan, number> = { starter: 2_000_000, pro: 8_000_000 };
export const TRIAL_DAYS = 7;
export const TRIAL_ALLOWANCE = 1_000_000;
export const PAST_DUE_GRACE = 7 * DAY;
export const COMP_PERIOD = 30 * DAY;
export const COMP_ALLOWANCE = ALLOWANCE.pro;
// Stripe statuses that still hold a trial or a paid period.
export const LIVE = new Set(["trialing", "active", "past_due"]);

export function priceFor(env: Env, plan: Plan): string {
  const price = plan === "pro" ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_STARTER;
  if (!price) throw new ApiError(503, "billing_unavailable", "Billing is unavailable. Try again in a minute.");
  return price;
}

export function planFor(env: Env, price: string): Plan | null {
  return price === env.STRIPE_PRICE_PRO ? "pro" : price === env.STRIPE_PRICE_STARTER ? "starter" : null;
}
