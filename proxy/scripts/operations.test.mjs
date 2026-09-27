import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from "node:fs/promises";
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
        MIXINGPAL_STAGING_PREFLIGHT_VERIFIED: preflight, MIXINGPAL_RELEASE_VERIFIED: release,
      } });
      assert.equal(result.status, allowed ? 0 : 1, `${stage}: ${result.stderr}`);
      if (!allowed) { await assert.rejects(access(join(dir, "calls.jsonl"))); continue; }
      const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(calls, [
        ["d1", "migrations", "apply", "DB", "--config", `.deploy-${stage}.json`, "--remote"],
        ["r2", "bucket", "lifecycle", "set", `mixing-pal-${stage}-capture`, "--file", lifecycle,
          "--config", `.deploy-${stage}.json`, "--force"],
        ["deploy", "--config", `.deploy-${stage}.json`],
      ]);
      const config = JSON.parse(await readFile(join(dir, `.deploy-${stage}.json`), "utf8"));
      assert.equal(config.vars.INFERENCE_ENABLED, "true");
      assert.equal(config.name, `mixing-pal-${stage}`);
      assert.deepEqual(JSON.parse(await readFile(lifecycle, "utf8")), { rules: [
        { id: "expire-captures", enabled: true, conditions: { prefix: "captures/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } } },
        { id: "expire-deletion-journal", enabled: true, conditions: { prefix: "deletions/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 7776000 } } },
        { id: "abort-incomplete-multipart-uploads", enabled: true, conditions: { prefix: "" },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } },
      ] });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
