import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, access, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operator, run } from "./admin.mjs";
import { configuration } from "./deploy.mjs";

test("operator exports retain a reference, and deletion prevents review and removes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixing-pal-ops-"));
  const file = join(dir, "turn.json");
  const output = [];
  let deleted = false;
  const connection = { origin: "https://api-staging.mixingpal.com", token: "private-operator-token", fetch: async (url, options) => {
    assert.equal(url.toString(), "https://api-staging.mixingpal.com/operator");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer private-operator-token");
    assert.equal(JSON.parse(options.body).action, "export");
    return deleted ? new Response(null, { status: 410 }) : Response.json({ expires_at: Date.now() + 60_000, complete: true, events: ["private project content"] });
  } };
  try {
    await run(["export", "member", "turn", file], connection, (text) => output.push(text));
    assert.doesNotMatch(await readFile(file, "utf8"), /private project|private-operator/);
    assert.doesNotMatch(output.join(""), /private project|private-operator/);
    await run(["review", file], connection, (text) => output.push(text));
    assert.match(output.at(-1), /private project content/);
    deleted = true;
    await assert.rejects(run(["review", file], connection), /410/);
    await assert.rejects(access(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator credentials never follow a plaintext or redirected public origin", async () => {
  let sent = 0;
  await assert.rejects(operator({ action: "usage" }, { origin: "http://api.mixingpal.com", token: "secret", fetch: async () => { sent++; } }), /HTTPS/);
  assert.equal(sent, 0);
});

test("invite command reports mail acceptance and gives a safe retry message on failure", async () => {
  const output = [];
  let rejected = false;
  const connection = { origin: "https://api.mixingpal.com", token: "operator-token", fetch: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { action: "invite", email: "producer@example.com" });
    return rejected ? Response.json({ error: "private provider details" }, { status: 502 })
      : Response.json({ code: "invitation-code", expires_at: 123, email_status: "accepted" });
  } };
  await run(["invite", "producer@example.com"], connection, (text) => output.push(text));
  assert.equal(JSON.parse(output[0]).email_status, "accepted");
  rejected = true;
  await assert.rejects(run(["invite", "producer@example.com"], connection), /Invitation email could not be confirmed.*new code/);
});

test("deployment isolates stages, begins paused, and rejects absent resource IDs", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const base = { main: "src/index.ts", vars: { MAIL_FROM: "sender" } };
  const staging = configuration(base, "staging", id);
  const production = configuration(base, "production", "11111111-1111-4111-8111-111111111111");
  assert.equal(staging.vars.INFERENCE_ENABLED, "false");
  assert.equal(production.vars.INFERENCE_ENABLED, "false");
  assert.notEqual(staging.vars.API_ORIGIN, production.vars.API_ORIGIN);
  assert.notEqual(staging.d1_databases[0].database_id, production.d1_databases[0].database_id);
  assert.notEqual(staging.r2_buckets[0].bucket_name, production.r2_buckets[0].bucket_name);
  assert.deepEqual(staging.r2_buckets.map(({ binding, bucket_name }) => [binding, bucket_name]), [
    ["CAPTURE", "mixing-pal-staging-capture"], ["RELEASES", "mixing-pal-staging-releases"],
  ]);
  assert.deepEqual(production.r2_buckets.map(({ binding, bucket_name }) => [binding, bucket_name]), [
    ["CAPTURE", "mixing-pal-production-capture"], ["RELEASES", "mixing-pal-production-releases"],
  ]);
  assert.equal(staging.vars.DOWNLOADS_ORIGIN, "https://downloads-staging.mixingpal.com");
  assert.equal(production.vars.DOWNLOADS_ORIGIN, "https://downloads.mixingpal.com");
  assert.notEqual(staging.r2_buckets[0].bucket_name, staging.r2_buckets[1].bucket_name);
  assert.throws(() => configuration(base, "production", undefined), /D1 UUID/);
  assert.throws(() => configuration(base, "typo", id), /staging or production/);
});

test("recovery commands send verified totals and reasons to the correct scope", async () => {
  const sent = [];
  const connection = { origin: "https://api-staging.mixingpal.com", token: "test-token", fetch: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return Response.json({ ok: true });
  } };
  await run(["recover-member", "member", "4800000", "Provider billing checked"], connection, () => {});
  await run(["recover-budget", "6500000", "Service billing checked"], connection, () => {});
  assert.deepEqual(sent, [
    { action: "recover", member_id: "member", spent_micro_usd: 4800000, reason: "Provider billing checked" },
    { action: "recover", spent_micro_usd: 6500000, reason: "Service billing checked" },
  ]);
});

test("resolve-without-id sends the cost and reason for every provisional row without an ID", async () => {
  const sent = [];
  const connection = { origin: "https://api-staging.mixingpal.com", token: "test-token", fetch: async (_url, options) => {
    sent.push(JSON.parse(options.body)); return Response.json({ outcome: "applied", resolved: 2 });
  } };
  await run(["resolve-without-id", "4000", "Provider billing checked"], connection, () => {});
  assert.deepEqual(sent, [{ action: "resolve_without_id", cost_micro_usd: 4000, reason: "Provider billing checked" }]);
  await assert.rejects(run(["resolve-without-id", "4000"], connection), /Unknown command or arguments/);
  assert.equal(sent.length, 1);
});


test("enable requires stage-specific checks before invoking Wrangler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixing-pal-deploy-"));
  const script = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
  const lifecycle = fileURLToPath(new URL("../r2-lifecycle.json", import.meta.url));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ vars: {} }));
    await mkdir(join(dir, "node_modules/wrangler/bin"), { recursive: true });
    await writeFile(join(dir, "node_modules/wrangler/bin/wrangler.js"),
      `require("node:fs").appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");`);
    for (const [stage, preflight, release, allowed] of [
      ["staging", "no", "no", false], ["staging", "no", "yes", false],
      ["staging", "yes", "no", true], ["production", "yes", "no", false],
      ["production", "no", "yes", true],
    ]) {
      await rm(join(dir, "calls.jsonl"), { force: true });
      const result = spawnSync(process.execPath, [script, "enable", stage], { cwd: dir, encoding: "utf8", env: {
        PATH: process.env.PATH, MIXINGPAL_D1_ID: "00000000-0000-4000-8000-000000000000",
        MIXINGPAL_STAGING_PREFLIGHT_VERIFIED: preflight, MIXINGPAL_RELEASE_VERIFIED: release, MIXINGPAL_BILLING: "off",
      } });
      assert.equal(result.status, allowed ? 0 : 1, `${stage}: ${result.stderr}`);
      if (!allowed) { await assert.rejects(access(join(dir, "calls.jsonl"))); continue; }
      const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      // The bundle is checked before any migration, so a bundle error never leaves the old Worker on the new schema.
      assert.deepEqual(calls, [
        ["deploy", "--config", `.deploy-${stage}.json`, "--dry-run"],
        ["d1", "migrations", "apply", "DB", "--config", `.deploy-${stage}.json`, "--remote"],
        ["r2", "bucket", "lifecycle", "set", `mixing-pal-${stage}-capture`, "--file", lifecycle,
          "--config", `.deploy-${stage}.json`, "--force"],
        ["deploy", "--config", `.deploy-${stage}.json`],
      ]);
      assert.match(result.stdout, /^Deploying commit unknown$/m);
      const config = JSON.parse(await readFile(join(dir, `.deploy-${stage}.json`), "utf8"));
      assert.equal(config.vars.INFERENCE_ENABLED, "true");
      assert.equal(config.name, `mixing-pal-${stage}`);
      assert.deepEqual(JSON.parse(await readFile(lifecycle, "utf8")), { rules: [
        { id: "expire-captures", enabled: true, conditions: { prefix: "captures/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } } },
        { id: "expire-support-reports", enabled: true, conditions: { prefix: "reports/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } } },
        { id: "expire-deletion-journal", enabled: true, conditions: { prefix: "deletions/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 7776000 } } },
        { id: "abort-incomplete-multipart-uploads", enabled: true, conditions: { prefix: "" },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } },
      ] });
    }
    // In a repository, deploy names the commit it ships, and checks the bundle first.
    await rm(join(dir, "calls.jsonl"), { force: true });
    const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "release");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const deployed = spawnSync(process.execPath, [script, "deploy", "staging"], { cwd: dir, encoding: "utf8", env: {
      PATH: process.env.PATH, MIXINGPAL_D1_ID: "00000000-0000-4000-8000-000000000000", MIXINGPAL_BILLING: "off",
      MIXINGPAL_STRIPE_PRICE_STARTER: "price_fromEnvironment", MIXINGPAL_STRIPE_PRICE_PRO: "price_fromEnvironment",
    } });
    assert.equal(deployed.status, 0, deployed.stderr);
    // Price IDs come from the committed file, never from the environment.
    const committed = JSON.parse(await readFile(fileURLToPath(new URL("../billing-prices.json", import.meta.url)), "utf8")).staging;
    const shipped = JSON.parse(await readFile(join(dir, ".deploy-staging.json"), "utf8")).vars;
    assert.deepEqual([shipped.STRIPE_PRICE_STARTER, shipped.STRIPE_PRICE_PRO], [committed.starter, committed.pro]);
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.match(deployed.stdout, new RegExp(`^Deploying commit ${head}$`, "m"));
    assert.deepEqual((await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), [
      ["deploy", "--config", ".deploy-staging.json", "--dry-run"],
      ["d1", "migrations", "apply", "DB", "--config", ".deploy-staging.json", "--remote"],
      ["r2", "bucket", "lifecycle", "set", "mixing-pal-staging-capture", "--file", lifecycle, "--config", ".deploy-staging.json", "--force"],
      ["deploy", "--config", ".deploy-staging.json"],
    ]);
    await rm(join(dir, "calls.jsonl"), { force: true });
    const recovery = spawnSync(process.execPath, [script, "recovery", "staging"], { cwd: dir, encoding: "utf8", env: {
      PATH: process.env.PATH, MIXINGPAL_D1_ID: "00000000-0000-4000-8000-000000000000", MIXINGPAL_BILLING: "off",
    } });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.deepEqual((await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse),
      [["deploy", "--config", ".deploy-staging.json"]]);
    const recovering = JSON.parse(await readFile(join(dir, ".deploy-staging.json"), "utf8"));
    assert.equal(recovering.vars.REPORT_RECOVERY, "true");
    assert.equal(recovering.vars.INFERENCE_ENABLED, "false");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("report inspection sends only an ID and does not save a transcript", async () => {
  const seen = [];
  const connection = { origin: "https://api.mixingpal.com", token: "test-operator", fetch: async (_, options) => {
    seen.push(JSON.parse(options.body)); return Response.json({ report: { description: "failed" } });
  } };
  const output = [];
  await run(["report", "00000000-0000-4000-8000-000000000001"], connection, s => output.push(s));
  await run(["report-notifications"], connection, s => output.push(s));
  assert.deepEqual(seen, [{ action: "report", report_id: "00000000-0000-4000-8000-000000000001" }, { action: "report_notifications" }]);
  assert.match(output[0], /failed/);
});


test("report recovery is a deployment setting outside the restored database", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const recovery = configuration({ vars: {} }, "staging", id, false, true);
  assert.equal(recovery.vars.REPORT_RECOVERY, "true");
  assert.equal(recovery.vars.INFERENCE_ENABLED, "false");
  assert.equal(configuration({ vars: {} }, "staging", id).vars.REPORT_RECOVERY, "false");
});

test("stats sends an optional day count and rejects anything else", async () => {
  const sent = [];
  const connection = { origin: "https://api.mixingpal.com", token: "operator-token", fetch: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ days: 28 });
  } };
  await run(["stats"], connection, () => {});
  await run(["stats", "7"], connection, () => {});
  assert.deepEqual(sent, [{ action: "stats" }, { action: "stats", days: 7 }]);
  await assert.rejects(run(["stats", "a week"], connection), /Unknown command or arguments/);
  await assert.rejects(run(["stats", "7", "8"], connection), /Unknown command or arguments/);
  assert.equal(sent.length, 2);
});

test("comp, uncomp and billing-sync send their operator actions", async () => {
  const sent = [];
  const connection = { origin: "https://api-staging.mixingpal.com", token: "t", fetch: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  } };
  await run(["comp", "partner@example.com"], connection, () => {});
  await run(["uncomp", "member-1"], connection, () => {});
  await run(["billing-sync", "member-1"], connection, () => {});
  assert.deepEqual(sent, [{ action: "comp", email: "partner@example.com" }, { action: "uncomp", member_id: "member-1" },
    { action: "billing_sync", member_id: "member-1" }]);
});

test("billing vars come from an explicit choice and the stage's committed price IDs, and on needs both", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const prices = { staging: { starter: "", pro: "price_1Pro" }, production: { starter: "price_1Starter", pro: "price_1Pro" } };
  const off = configuration({ vars: {} }, "staging", id);
  assert.equal(off.vars.BILLING_ENABLED, "false");
  const live = configuration({ vars: {} }, "production", id, true, false, true, prices);
  assert.deepEqual([live.vars.BILLING_ENABLED, live.vars.STRIPE_PRICE_STARTER, live.vars.STRIPE_PRICE_PRO], ["true", "price_1Starter", "price_1Pro"]);
  assert.throws(() => configuration({ vars: {} }, "staging", id, false, false, true, prices), /price IDs.*billing-prices\.json/);
});

test("an off deploy still carries the file's price IDs, so existing subscribers keep their plan", () => {
  const prices = { staging: { starter: "", pro: "" }, production: { starter: "price_1Starter", pro: "price_1Pro" } };
  const off = configuration({ vars: {} }, "production", "11111111-1111-4111-8111-111111111111", true, false, false, prices);
  assert.deepEqual([off.vars.BILLING_ENABLED, off.vars.STRIPE_PRICE_STARTER, off.vars.STRIPE_PRICE_PRO], ["false", "price_1Starter", "price_1Pro"]);
});

test("deploy without MIXINGPAL_BILLING stops before any Wrangler call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixing-pal-deploy-"));
  const script = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ vars: {} }));
    await mkdir(join(dir, "node_modules/wrangler/bin"), { recursive: true });
    await writeFile(join(dir, "node_modules/wrangler/bin/wrangler.js"),
      `require("node:fs").appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");`);
    const result = spawnSync(process.execPath, [script, "deploy", "staging"], { cwd: dir, encoding: "utf8", env: {
      PATH: process.env.PATH, MIXINGPAL_D1_ID: "00000000-0000-4000-8000-000000000000",
    } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Set MIXINGPAL_BILLING=on or off/);
    await assert.rejects(access(join(dir, "calls.jsonl")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the operator help names every event the proxy logs, so each can be alerted on", async () => {
  const output = [];
  await run(["help"], {}, (text) => output.push(text));
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const names = new Set();
  for (const file of await readdir(src)) {
    for (const [, logged] of (await readFile(join(src, file), "utf8")).matchAll(/JSON\.stringify\(\{ event: ([^,}]+)/g)) {
      for (const [, name] of logged.matchAll(/"(\w+)"/g)) names.add(name);
    }
  }
  assert.ok(names.has("subscription_canceled_unrefunded"));
  assert.deepEqual([...names].filter((name) => !new RegExp(`\\b${name}\\b`).test(output[0])), []);
});

test("the Stripe runbook in the deploy help uses the API version the proxy sends", async () => {
  const script = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "help"], { encoding: "utf8" }).stdout;
  const version = (await readFile(fileURLToPath(new URL("../src/stripe.ts", import.meta.url)), "utf8")).match(/STRIPE_VERSION = "([^"]+)"/)[1];
  assert.match(help, new RegExp(`API version ${version.replaceAll(".", "\\.")}`));
  assert.match(help, /\/webhooks\/stripe/);
  // A Portal upgrade would charge with no allowance: only the app's upgrade grants it.
  assert.match(help, /Plan switching off/);
  assert.doesNotMatch(help, /downgrades/i);
});

test("the restore sequence names a fallback for subscriptions billing-sync cannot find", async () => {
  const output = [];
  await run(["help"], {}, (text) => output.push(text));
  assert.match(output[0], /billing-sync member-id[\s\S]*resend the subscriptions' events from\s+the Stripe Dashboard/);
});
