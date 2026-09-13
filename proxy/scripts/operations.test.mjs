import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
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
