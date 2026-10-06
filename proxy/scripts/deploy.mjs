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
  npx wrangler r2 bucket create mixing-pal-staging-releases
  npx wrangler d1 create mixing-pal-production --location weur
  npx wrangler r2 bucket create mixing-pal-production-capture
  npx wrangler r2 bucket create mixing-pal-production-releases

Use the matching database UUID as MIXINGPAL_D1_ID. Cloudflare account/API token
come from Wrangler login or CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN.

  node scripts/deploy.mjs configure staging|production
  node scripts/deploy.mjs check staging|production       Bundle without deploying
  node scripts/deploy.mjs deploy staging|production      Check the bundle, apply additive migrations, deploy paused
  node scripts/deploy.mjs secrets staging|production     Read secrets from environment, not argv
  node scripts/deploy.mjs enable staging|production      Deploy with inference enabled
  node scripts/deploy.mjs recovery staging|production    Pause inference and reporting before D1 restore
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

The recovery command sets REPORT_RECOVERY=true in Worker configuration, outside
D1. Keep it enabled through every deletion replay page and spending recovery.
See npm run admin -- help for the restore sequence.

Rollback changes only the Worker version; never reverse ledger migrations.
A Worker older than the latest ledger migration cannot admit calls. To roll
back, pause inference (npm run admin -- pause), then deploy the previous
version. Keep inference paused until you deploy a fixed Worker forward. On the
fixed version, run health/usage/sweep and a staging smoke, then resume. Do not
run recover on a rolled-back Worker.

For an initial staging test use MIXINGPAL_PROXY_URL=https://api-staging.mixingpal.com
with a debug desktop build. Public release builds always use api.mixingpal.com.
Internal developer transport: npm run tauri -- dev --features direct-provider.
`;

export function configuration(base, stage, databaseId, enabled = false, reportRecovery = false) {
  if (!["staging", "production"].includes(stage)) throw new Error("Choose staging or production.");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databaseId ?? "")) throw new Error("Set MIXINGPAL_D1_ID to this stage's D1 UUID.");
  const host = stage === "production" ? "api.mixingpal.com" : "api-staging.mixingpal.com";
  const captureBucket = `mixing-pal-${stage}-capture`;
  const releaseBucket = `mixing-pal-${stage}-releases`;
  if (captureBucket === releaseBucket) throw new Error("Release and capture buckets must be distinct.");
  return { ...base, name: `mixing-pal-${stage}`, routes: [{ pattern: host, custom_domain: true }],
    vars: { ...base.vars, API_ORIGIN: `https://${host}`, INFERENCE_ENABLED: String(enabled), REPORT_RECOVERY: String(reportRecovery),
      DOWNLOADS_ORIGIN: stage === "production" ? "https://downloads.mixingpal.com" : "https://downloads-staging.mixingpal.com" },
    d1_databases: [{ binding: "DB", database_name: `mixing-pal-${stage}`, database_id: databaseId, migrations_dir: "migrations" }],
    r2_buckets: [{ binding: "CAPTURE", bucket_name: captureBucket }, { binding: "RELEASES", bucket_name: releaseBucket }] };
}

function wrangler(args, input) {
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], input, env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error("Wrangler did not complete the operation.");
}

function commit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return result.error || result.status !== 0 ? "unknown" : result.stdout.trim();
}

export async function run(args) {
  const [command, stage, version] = args;
  if (!command || command === "help" || command === "--help") { console.log(help); return; }
  if (!["configure", "check", "deploy", "secrets", "enable", "recovery", "rollback"].includes(command)) throw new Error("Unknown deployment command.");
  if (command === "enable") {
    const check = stage === "staging" ? "MIXINGPAL_STAGING_PREFLIGHT_VERIFIED" : "MIXINGPAL_RELEASE_VERIFIED";
    if (process.env[check] !== "yes") throw new Error(`Complete the ${stage} checks shown by help and set ${check}=yes before enable.`);
  }
  const base = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const config = configuration(base, stage, process.env.MIXINGPAL_D1_ID, command === "enable", command === "recovery");
  const file = `.deploy-${stage}.json`;
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (command === "configure") { console.log(file); return; }
  if (command === "check") { wrangler(["deploy", "--config", file, "--dry-run"]); return; }
  if (command === "recovery") { wrangler(["deploy", "--config", file]); return; }
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
  // Bundle first: a bundle error must never leave the old Worker running on the new schema.
  wrangler(["deploy", "--config", file, "--dry-run"]);
  wrangler(["d1", "migrations", "apply", "DB", "--config", file, "--remote"]);
  const lifecycle = fileURLToPath(new URL("../r2-lifecycle.json", import.meta.url));
  wrangler(["r2", "bucket", "lifecycle", "set", `mixing-pal-${stage}-capture`, "--file", lifecycle,
    "--config", file, "--force"]);
  // Printed beside Wrangler's version ID, so each Worker version maps to a commit.
  console.log(`Deploying commit ${commit()}`);
  wrangler(["deploy", "--config", file]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
