#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Pilot deployment (run from proxy/)

Provision separate resources, once for each stage:
Workers Paid is required for the maintenance query budget (up to 1,000 D1
queries per invocation). Platform charges are separate from model allowances.

  npx wrangler d1 create mixing-pal-staging --location weur
  npx wrangler r2 bucket create mixing-pal-staging-capture
  npx wrangler d1 create mixing-pal-production --location weur
  npx wrangler r2 bucket create mixing-pal-production-capture

Use the matching database UUID as MIXINGPAL_D1_ID. Cloudflare account/API token
come from Wrangler login or CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN.

  node scripts/deploy.mjs configure staging|production
  node scripts/deploy.mjs check staging|production       Bundle without deploying
  node scripts/deploy.mjs deploy staging|production      Apply additive migrations, deploy paused
  node scripts/deploy.mjs secrets staging|production     Read secrets from environment, not argv
  node scripts/deploy.mjs enable staging|production      Deploy with inference enabled
  node scripts/deploy.mjs rollback staging|production version-id

secrets reads AUTH_SECRET (at least 32 random characters), RESEND_KEY,
OPENROUTER_KEY and ADMIN_TOKEN. Keep independent values for staging/production.
Configure the sending domain signin@mixingpal.com in Resend first. The auth
secret must stay stable across deployments; rotating it revokes sessions and
changes request fingerprints. Deploy never prints secret values.

Before enabling staging: verify sign-in delivery, provider prices and strict
ZDR routing, disable OpenRouter input/output logging and content use, and set
its API key credit cap. In Cloudflare, create account-wide budget alerts at
$10 and $25. Budget alerts warn; they do not cap usage. Invite only your test
account until the smoke passes.
Pass MIXINGPAL_STAGING_PREFLIGHT_VERIFIED=yes to acknowledge this preflight.
Then run an invited staging turn, exercise capture off/on/withdrawal/deletion,
and rehearse rollback before inviting pilot producers or enabling production.

Before enabling production: complete those staging checks and verify production
email, provider policy and its $50 API key cap with no replenishment.
Pass MIXINGPAL_RELEASE_VERIFIED=yes to acknowledge these release checks.

Rollback changes only the Worker version; never reverse ledger migrations.
Keep schema changes additive and compatible with the previous version. First
pause admissions using the operator CLI, deploy the previous known-good
version, run health/usage/sweep and a staging smoke, then resume.

For an initial staging test use MIXINGPAL_PROXY_URL=https://api-staging.mixingpal.com
with a debug desktop build. Public release builds always use api.mixingpal.com.
Internal developer transport: npm run tauri -- dev --features direct-provider.
`;

export function configuration(base, stage, databaseId, enabled = false) {
  if (!["staging", "production"].includes(stage)) throw new Error("Choose staging or production.");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databaseId ?? "")) throw new Error("Set MIXINGPAL_D1_ID to this stage's D1 UUID.");
  const host = stage === "production" ? "api.mixingpal.com" : "api-staging.mixingpal.com";
  return { ...base, name: `mixing-pal-${stage}`, routes: [{ pattern: host, custom_domain: true }],
    vars: { ...base.vars, API_ORIGIN: `https://${host}`, INFERENCE_ENABLED: String(enabled) },
    d1_databases: [{ binding: "DB", database_name: `mixing-pal-${stage}`, database_id: databaseId, migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "CAPTURE", bucket_name: `mixing-pal-${stage}-capture` }] };
}

function wrangler(args, input) {
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], input, env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error("Wrangler did not complete the operation.");
}

export async function run(args) {
  const [command, stage, version] = args;
  if (!command || command === "help" || command === "--help") { console.log(help); return; }
  if (!["configure", "check", "deploy", "secrets", "enable", "rollback"].includes(command)) throw new Error("Unknown deployment command.");
  if (command === "enable") {
    const check = stage === "staging" ? "MIXINGPAL_STAGING_PREFLIGHT_VERIFIED" : "MIXINGPAL_RELEASE_VERIFIED";
    if (process.env[check] !== "yes") throw new Error(`Complete the ${stage} checks shown by help and set ${check}=yes before enable.`);
  }
  const base = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const config = configuration(base, stage, process.env.MIXINGPAL_D1_ID, command === "enable");
  const file = `.deploy-${stage}.json`;
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (command === "configure") { console.log(file); return; }
  if (command === "check") { wrangler(["deploy", "--config", file, "--dry-run"]); return; }
  if (command === "secrets") {
    const names = ["AUTH_SECRET", "RESEND_KEY", "OPENROUTER_KEY", "ADMIN_TOKEN"];
    if (names.some((name) => !process.env[name]) || process.env.AUTH_SECRET.length < 32) throw new Error("Set all four service secrets; AUTH_SECRET needs at least 32 characters.");
    wrangler(["secret", "bulk", "--config", file], JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name]]))));
    return;
  }
  if (command === "rollback") {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(version ?? "")) throw new Error("rollback needs a known-good Worker version UUID.");
    wrangler(["versions", "deploy", `${version}@100%`, "--config", file, "--yes"]);
    return;
  }
  wrangler(["d1", "migrations", "apply", "DB", "--config", file, "--remote"]);
  const lifecycle = fileURLToPath(new URL("../r2-lifecycle.json", import.meta.url));
  wrangler(["r2", "bucket", "lifecycle", "set", `mixing-pal-${stage}-capture`, "--file", lifecycle,
    "--config", file, "--force"]);
  wrangler(["deploy", "--config", file]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
