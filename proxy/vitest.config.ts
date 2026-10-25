import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
      RESEND_KEY: "test-resend-key", OPENROUTER_KEY: "test-provider-key", ADMIN_TOKEN: "test-operator-key",
      INFERENCE_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_proxy", STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro",
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
    } },
  })],
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["./tests/setup.ts"], fileParallelism: false },
});
