import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, expect } from "vitest";
import { unrouted } from "./stripe-fixtures";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

afterEach(() => expect(unrouted.splice(0), "Stripe calls with no stubbed route").toEqual([]));
