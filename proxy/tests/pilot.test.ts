import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { hash, DAY } from "../src/env";
import { settle } from "../src/ledger";
import { redeem } from "../src/account";
import { maintain } from "../src/maintenance";
import { RESERVATION } from "../src/policy";
import { runTurn } from "../../src/agent/loop";

async function capturedObjects() { return (await env.CAPTURE.list()).objects.filter((object) => !object.key.startsWith("deletions/")); }

const provider = "https://openrouter.ai";
let sent: unknown[];
let otpSent: string;
let replies: Record<string, unknown>[];

async function api(path: string, body?: unknown, token?: string, method = body === undefined ? "GET" : "POST") {
  return worker.fetch(new Request(`http://localhost:8787${path}`, { method,
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "127.0.0.1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, createExecutionContext());
}

async function invited(email = "producer@example.com") {
  const code = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
    .bind(await hash(code), email, Date.now() + DAY).run();
  const start = await api("/auth/email-otp/send-verification-otp", { email });
  expect(start.status, await start.clone().text()).toBe(200);
  const signed = await api("/auth/sign-in/email-otp", { email, otp: otpSent });
  expect(signed.status, await signed.clone().text()).toBe(200);
  const token = signed.headers.get("set-auth-token")!;
  expect(token).toBeTruthy();
  const user = await signed.json() as { user: { id: string } };
  return { token, code, id: user.user.id };
}

async function joined(email?: string) {
  const user = await invited(email);
  const result = await api("/v1/invites/redeem", { code: user.code }, user.token);
  expect(result.status, await result.clone().text()).toBe(200);
  return user;
}

function question(round = 1, turnId = crypto.randomUUID()) {
  return { turn_id: turnId, request_id: crypto.randomUUID(), round, app_version: "0.2.4", wire_version: 12, capture_epoch: 1 as number | null | undefined,
    body: { messages: [{ role: "system", content: "original prompt" }, { role: "user", content: "secret project question" }],
      tools: [{ type: "function", function: { name: "get_arrangement", description: "Read the timeline", parameters: { type: "object" } } }],
      model: "expensive-model", max_tokens: 999999, provider: { only: ["attacker"] } } };
}

function reply(extra: Record<string, unknown> = {}) {
  replies.push({ id: "generation-1", provider: "DeepInfra",
      usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ finish_reason: "stop", message: { content: "raw answer\n```note\n+ heard example\n```" } }], ...extra });
}

beforeEach(async () => {
  sent = [];
  replies = [];
  otpSent = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url) === "https://api.resend.com/emails") {
      const body = JSON.parse(String(options?.body));
      otpSent = body.text.match(/code is (\d{6})/)[1];
      return Response.json({ id: "email-id" });
    }
    if (String(url) === `${provider}/api/v1/models/minimax/minimax-m3/endpoints`) {
      return Response.json({ data: { endpoints: [{ tag: "deepinfra/fp8", status: 0, context_length: 524288,
        pricing: { prompt: "0.00000028", completion: "0.0000011" } }] } });
    }
    if (String(url) === `${provider}/api/v1/chat/completions`) {
      sent.push(JSON.parse(String(options?.body)));
      const response = replies.shift();
      if (!response) throw new Error("No scripted provider response");
      return Response.json(response);
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  });
  await env.DB.batch(["operator_actions", "deletion_jobs", "captures", "requests", "turns", "consents", "invites", "members", "session", "account", "user", "verification", "rateLimit", "api_limits"]
    .map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
  await env.DB.prepare("UPDATE budget SET spent = 0, reserved = 0, allowance = 50000000, paused = 0, recovery_required = 0").run();
  const objects = await env.CAPTURE.list();
  await Promise.all(objects.objects.map((o) => env.CAPTURE.delete(o.key)));
});
afterEach(() => vi.restoreAllMocks());

describe("invited accounts", () => {
  test("sign-in sends the same usable code in HTML and plain text", async () => {
    await invited();
    const delivery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "https://api.resend.com/emails");
    const email = JSON.parse(String(delivery![1]?.body));
    expect(email.to).toEqual(["producer@example.com"]);
    expect(email.text).toContain(otpSent);
    expect(email.html).toContain(`>${otpSent}</`);
  });

  test("account availability follows the deployment inference switch", async () => {
    const user = await joined();
    const enabled = env.INFERENCE_ENABLED;
    try {
      env.INFERENCE_ENABLED = "false";
      const paused = await (await api("/v1/account", undefined, user.token)).json();
      expect(paused.can_ask).toBe(false);
      expect(paused.service_paused).toBe(true);
      expect((await api("/v1/completions", question(), user.token)).status).toBe(503);
      expect(sent).toHaveLength(0);
    } finally { env.INFERENCE_ENABLED = enabled; }
    const active = await (await api("/v1/account", undefined, user.token)).json();
    expect(active.can_ask).toBe(true);
    expect(active.service_paused).toBe(false);
  });

  test("deletion before redemption invalidates the invitation immediately", async () => {
    const user = await invited();
    expect((await api("/v1/account", undefined, user.token, "DELETE")).status).toBe(202);
    expect((await env.DB.prepare("SELECT code_hash FROM invites WHERE email = ?").bind("producer@example.com").all()).results).toHaveLength(0);
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    const signed = await api("/auth/sign-in/email-otp", { email: "producer@example.com", otp: otpSent });
    expect(signed.status).toBe(401);
    expect(await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(user.id).first()).toBeNull();
  });

  test("a pending deletion denies a newly issued invitation and a late sign-in session", async () => {
    const user = await invited();
    const session = await env.DB.prepare('SELECT * FROM "session" WHERE userId = ?').bind(user.id).first();
    await api("/v1/account", undefined, user.token, "DELETE");
    const invite = await (await api("/operator", { action: "invite", email: "producer@example.com" }, env.ADMIN_TOKEN)).json();
    const columns = Object.keys(session).map((key) => `"${key}"`).join(",");
    await env.DB.prepare(`INSERT INTO "session" (${columns}) VALUES (${Object.keys(session).map(() => "?").join(",")})`)
      .bind(...Object.values(session)).run();
    expect((await api("/v1/invites/redeem", { code: invite.code }, user.token)).status).toBe(401);
    // A request can have authenticated before deletion committed.
    await expect(redeem(env, user.id, { code: invite.code })).rejects.toMatchObject({ status: 403 });
    expect(await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(user.id).first()).toBeNull();
  });

  test("requires a verified email and consumes the invite once without resetting allowance", async () => {
    const user = await invited();
    const before = await api("/v1/account", undefined, user.token);
    expect((await before.json()).access).toBe("invitation_required");
    const results = await Promise.all([api("/v1/invites/redeem", { code: user.code }, user.token),
      api("/v1/invites/redeem", { code: user.code }, user.token)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    await env.DB.prepare("UPDATE members SET spent = 42 WHERE id = ?").bind(user.id).run();
    const again = await api("/v1/invites/redeem", { code: user.code }, user.token);
    expect((await again.json()).remaining_micro_usd).toBe(4999958);
  });

  test("cannot redeem another email's invite", async () => {
    const alice = await invited();
    const bob = await invited("bob@example.com");
    expect((await api("/v1/invites/redeem", { code: alice.code }, bob.token)).status).toBe(403);
  });

  test("sign out revokes an existing bearer session", async () => {
    const user = await joined();
    expect((await api("/auth/sign-out", {}, user.token)).status).toBe(200);
    expect((await api("/v1/account", undefined, user.token)).status).toBe(401);
  });

  test("sign out does not report success when the auth library swallows a failed deletion", async () => {
    const user = await joined();
    await env.DB.exec('CREATE TRIGGER fail_sign_out BEFORE DELETE ON "session" BEGIN SELECT RAISE(ABORT, \'unavailable\'); END');
    try {
      expect((await api("/auth/sign-out", {}, user.token)).status).toBe(503);
      expect((await api("/v1/account", undefined, user.token)).status).toBe(200);
    } finally { await env.DB.exec("DROP TRIGGER fail_sign_out"); }
    expect((await api("/auth/sign-out", {}, user.token)).status).toBe(200);
    expect((await api("/v1/account", undefined, user.token)).status).toBe(401);
  });
});

describe("metered requests", () => {
  test("restore requires fresh sharing consent and preserves revoked access", async () => {
    const user = await joined();
    const revoked = await joined("revoked@example.com");
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const sessions = (await env.DB.prepare('SELECT * FROM "session" WHERE userId = ?').bind(revoked.id).all()).results;
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-12" }, user.token, "PUT");
    expect((await api("/operator", { action: "revoke", member_id: revoked.id }, env.ADMIN_TOKEN)).status).toBe(200);
    await env.DB.prepare("UPDATE members SET capture = 1, consent_epoch = 1 WHERE id = ?").bind(user.id).run();
    await env.DB.prepare("UPDATE members SET revoked = 0 WHERE id = ?").bind(revoked.id).run();
    for (const session of sessions) {
      const columns = Object.keys(session).map((key) => `"${key}"`).join(",");
      await env.DB.prepare(`INSERT INTO "session" (${columns}) VALUES (${Object.keys(session).map(() => "?").join(",")})`)
        .bind(...Object.values(session)).run();
    }
    expect((await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN)).status).toBe(200);
    for (const member_id of [user.id, revoked.id, undefined]) {
      expect((await api("/operator", { action: "recover", member_id, spent_micro_usd: 0,
        reason: "Verified no charges were lost" }, env.ADMIN_TOKEN)).status).toBe(200);
    }
    expect((await api("/operator", { action: "pause", paused: false }, env.ADMIN_TOKEN)).status).toBe(200);
    const view = await (await api("/v1/account", undefined, user.token)).json();
    expect(view.capture).toBe(false);
    reply();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
    expect(await capturedObjects()).toHaveLength(0);
    expect((await api("/v1/completions", question(), revoked.token)).status).toBe(401);
    expect((await env.DB.prepare("SELECT revoked FROM members WHERE id = ?").bind(revoked.id).first()).revoked).toBe(1);
    const consent = await (await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT")).json();
    reply();
    await api("/v1/completions", { ...question(), capture_epoch: consent.consent_epoch }, user.token);
    expect(await capturedObjects()).toHaveLength(1);
  });

  test("revocation cannot succeed without its restore journal", async () => {
    const user = await joined();
    vi.spyOn(env.CAPTURE, "put").mockRejectedValue(new Error("journal unavailable"));
    expect((await api("/operator", { action: "revoke", member_id: user.id }, env.ADMIN_TOKEN)).status).toBe(503);
    expect((await (await api("/v1/account", undefined, user.token)).json()).access).toBe("active");
  });

  test("a restored ledger stays paused until account and global spending are recovered", async () => {
    const user = await joined();
    const unused = await invited("restored-invite@example.com");
    // Restored rows contain balances from before the producer spent $4.80.
    const replay = await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN);
    expect(replay.status).toBe(200);
    expect((await api("/v1/invites/redeem", { code: unused.code }, unused.token)).status).toBe(403);
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ can_ask: false, service_paused: true });
    await maintain(env);
    expect((await api("/operator", { action: "pause", paused: false }, env.ADMIN_TOKEN)).status).toBe(409);
    expect((await api("/v1/completions", question(), user.token)).status).toBe(503);
    const recover = (member_id: string | undefined, spent_micro_usd: number) => api("/operator", {
      action: "recover", member_id, spent_micro_usd, reason: "Verified against pre-restore records and provider billing",
    }, env.ADMIN_TOKEN);
    expect((await recover(undefined, 4800000)).status).toBe(409);
    expect((await recover(user.id, 4800000)).status).toBe(200);
    expect((await recover(undefined, 4799999)).status).toBe(409);
    expect((await recover(undefined, 4800000)).status).toBe(200);
    expect((await api("/operator", { action: "pause", paused: false }, env.ADMIN_TOKEN)).status).toBe(200);
    expect((await api("/v1/completions", question(), user.token)).status).toBe(402);
    const restored = await (await api("/v1/account", undefined, user.token)).json();
    expect(restored).toMatchObject({ can_ask: false, remaining_micro_usd: 200000, service_paused: false });
    expect((await env.DB.prepare("SELECT action, detail FROM operator_actions WHERE action = 'recover'").all()).results).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });

  test("recovery refuses unresolved or decreasing spending and keeps its audit atomic", async () => {
    const user = await joined();
    reply({ usage: null });
    const request = question();
    await api("/v1/completions", request, user.token);
    await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN);
    const recover = (spent_micro_usd: number) => api("/operator", { action: "recover", member_id: user.id,
      spent_micro_usd, reason: "Verified recovery amount" }, env.ADMIN_TOKEN);
    expect((await recover(1000)).status).toBe(409);
    await settle(env, request.request_id, 1000);
    expect((await recover(999)).status).toBe(409);
    await env.DB.exec("CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
    try { expect((await recover(1000)).status).toBe(503); }
    finally { await env.DB.exec("DROP TRIGGER fail_recovery_audit"); }
    expect((await env.DB.prepare("SELECT recovery_required FROM members WHERE id = ?").bind(user.id).first()).recovery_required).toBe(1);
    expect((await recover(1000)).status).toBe(200);
  });

  test("five unknown generations retain the global concurrency limit", async () => {
    for (let i = 0; i < 5; i++) {
      const user = await joined(`producer-${i}@example.com`);
      reply({ usage: null });
      expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
      expect((await (await api("/v1/account", undefined, user.token)).json()).can_ask).toBe(false);
    }
    const waiting = await joined("waiting@example.com");
    expect((await api("/v1/completions", question(), waiting.token)).status).toBe(429);
    expect(sent).toHaveLength(5);
  });

  test("measures local completion overhead against the stub provider", async ({ task }) => {
    const user = await joined();
    const overhead: number[] = [];
    for (let i = 0; i < 20; i++) {
      reply();
      const startDirect = performance.now();
      await (await fetch(`${provider}/api/v1/chat/completions`, { method: "POST", body: "{}" })).json();
      const direct = performance.now() - startDirect;
      reply();
      const startProxy = performance.now();
      const response = await api("/v1/completions", question(), user.token);
      expect(response.status).toBe(200);
      overhead.push(performance.now() - startProxy - direct);
    }
    overhead.sort((a, b) => a - b);
    task.meta.latency = { environment: "local Worker with stub upstream", completions: 20,
      p50_added_ms: overhead[9], p95_added_ms: overhead[18], total_model_cost_micro_usd: 20000 };
    expect((await env.DB.prepare("SELECT spent FROM budget").first()).spent).toBe(20000);
  });
  test("failed generations retain opted-in request evidence and never claim completeness", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const request = question();
    expect((await api("/v1/completions", request, user.token)).status).toBe(504);
    const objects = await capturedObjects();
    expect(objects).toHaveLength(1);
    expect(await (await env.CAPTURE.get(objects[0].key))!.json()).toMatchObject({ kind: "model_failure", body: sent[0] });
    expect((await env.DB.prepare("SELECT incomplete FROM turns").first()).incomplete).toBe(1);
  });

  test("an unresolvable generation does not prevent reconciliation of another account", async () => {
    const user = await joined();
    const other = await joined("other@example.com");
    for (let i = 0; i < 2; i++) {
      reply({ id: `held-${i}`, usage: null });
      expect((await api("/v1/completions", question(), i === 0 ? user.token : other.token)).status).toBe(200);
    }
    const original = globalThis.fetch;
    const checked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (!String(url).includes("/generation?")) return original(url, options);
      checked.push(String(url));
      return Promise.resolve(String(url).endsWith("held-1") ? Response.json({ data: { total_cost: 0.001 } }) : new Response(null, { status: 404 }));
    });
    await maintain(env);
    await maintain(env);
    expect(checked).toHaveLength(2);
    expect((await env.DB.prepare("SELECT status FROM requests WHERE generation_id = 'held-1'").first()).status).toBe("settled");
  });
  test("a provider interruption holds cost; a sweep reconciles a known generation", async () => {
    const user = await joined();
    const request = question();
    expect((await api("/v1/completions", request, user.token)).status).toBe(504);
    expect((await env.DB.prepare("SELECT reserved FROM budget").first()).reserved).toBe(RESERVATION);
    expect((await api("/v1/completions", question(), user.token)).status).toBe(429);
    expect(sent).toHaveLength(1);
    await env.DB.prepare("UPDATE requests SET generation_id = 'known-generation'").run();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => String(url).includes("/generation?")
      ? Promise.resolve(Response.json({ data: { total_cost: 0.002 } })) : original(url, options));
    await maintain(env);
    expect((await env.DB.prepare("SELECT spent, reserved FROM budget").first())).toEqual({ spent: 2000, reserved: 0 });
  });

  test("a settlement failure cannot silently release its reservation", async () => {
    const user = await joined();
    await env.DB.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE OF cost ON requests BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
    try {
      reply();
      expect((await api("/v1/completions", question(), user.token)).status).toBe(503);
      expect((await env.DB.prepare("SELECT reserved FROM budget").first()).reserved).toBe(RESERVATION);
      await env.DB.prepare("UPDATE requests SET updated_at = ?").bind(Date.now() - 6 * 60_000).run();
      await maintain(env);
      expect((await env.DB.prepare("SELECT status FROM requests").first()).status).toBe("unknown");
    } finally { await env.DB.exec("DROP TRIGGER fail_settlement"); }
  });

  test("never exposes a provider credential in a reply or capture", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    reply({ choices: [{ finish_reason: "stop", message: { content: env.OPENROUTER_KEY } }] });
    const result = await api("/v1/completions", question(), user.token);
    expect(await result.text()).not.toContain(env.OPENROUTER_KEY);
    for (const object of await capturedObjects()) {
      expect(await (await env.CAPTURE.get(object.key))!.text()).not.toContain(env.OPENROUTER_KEY);
    }
  });

  test("global allowance and round ownership are checked inside admission", async () => {
    const first = await joined();
    const second = await joined("second@example.com");
    const request = question();
    reply();
    await api("/v1/completions", request, first.token);
    expect((await api("/v1/completions", question(2, request.turn_id), second.token)).status).toBe(409);
    expect((await api("/v1/completions", question(7), first.token)).status).toBe(400);
    await env.DB.prepare("UPDATE budget SET allowance = spent").run();
    expect((await api("/v1/completions", question(), second.token)).status).toBe(402);
    expect(sent).toHaveLength(1);
  });
  test("applies server policy and settles actual cost without persisting project content", async () => {
    const user = await joined();
    reply();
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).text).toContain("```note");
    expect(sent[0]).toMatchObject({ model: "minimax/minimax-m3", max_tokens: 4096, provider: { only: ["deepinfra/fp8"], zdr: true } });
    const row = await env.DB.prepare("SELECT spent, reserved FROM members WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ spent: 1000, reserved: 0 });
    expect(await capturedObjects()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT * FROM requests").all()).results[0].usage).not.toContain("secret project");
  });

  test("declines exhausted or revoked accounts before an upstream generation", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET allowance = 0 WHERE id = ?").bind(user.id).run();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(402);
    await env.DB.prepare("UPDATE members SET revoked = 1 WHERE id = ?").bind(user.id).run();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test("simultaneous requests cannot spend the same allowance", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET allowance = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    reply({ usage: { cost: RESERVATION / 1_000_000, prompt_tokens: 1, completion_tokens: 1 } });
    const results = await Promise.all([api("/v1/completions", question(), user.token), api("/v1/completions", question(), user.token)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => [402, 429].includes(r.status))).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("a repeated request ID never starts or charges a second generation", async () => {
    const user = await joined();
    const request = question();
    reply();
    expect((await api("/v1/completions", request, user.token)).status).toBe(200);
    expect((await api("/v1/completions", request, user.token)).status).toBe(409);
    expect(sent).toHaveLength(1);
    await settle(env, request.request_id, 1000);
    expect((await env.DB.prepare("SELECT spent FROM budget").first()).spent).toBe(1000);
  });

  test("missing usage holds a reservation and blocks the next tool round", async () => {
    const user = await joined();
    const request = question();
    reply({ usage: null, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
      { id: "call-1", type: "function", function: { name: "get_arrangement", arguments: "{}" } },
    ] } }] });
    expect((await api("/v1/completions", request, user.token)).status).toBe(503);
    expect((await env.DB.prepare("SELECT status, reserved FROM requests").first())).toEqual({ status: "unknown", reserved: RESERVATION });
    expect((await api("/v1/completions", question(2, request.turn_id), user.token)).status).toBe(409);
  });
});

describe("capture and deletion", () => {
  test.each([null, undefined, 0])("capture uses the turn-start consent %s, not a later opt-in", async (capture_epoch) => {
    const user = await joined();
    const request = { ...question(), capture_epoch };
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    reply();
    const result = await api("/v1/completions", request, user.token);
    expect(result.status).toBe(200);
    expect((await result.json()).capture).toBe(false);
    reply();
    await api("/v1/completions", question(2, request.turn_id), user.token);
    expect(await capturedObjects()).toHaveLength(0);
    reply();
    await api("/v1/completions", question(), user.token);
    expect(await capturedObjects()).toHaveLength(1);
  });

  test("withdrawing and enabling again cannot revive an earlier consent version", async () => {
    const user = await joined();
    for (const enabled of [true, false, true]) {
      await api("/v1/consent", { enabled, version: "quality-2026-09-12" }, user.token, "PUT");
    }
    reply();
    const result = await api("/v1/completions", question(), user.token);
    expect(result.status).toBe(200);
    expect((await result.json()).capture).toBe(false);
    expect(await capturedObjects()).toHaveLength(0);
  });

  test("the app's real tool loop completes through the proxy and exports replayable evidence", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const turnId = crypto.randomUUID();
    reply({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
      { id: "read-1", type: "function", function: { name: "get_arrangement", arguments: "{}" } },
    ] } }] });
    reply();
    const out = await runTurn({ complete: async (messages, ids) => {
      const input = question(ids!.round, turnId);
      input.request_id = ids!.requestId;
      const response = await api("/v1/completions", { ...input, body: { ...input.body,
        messages: [{ role: "system", content: "original prompt" }, ...messages] } }, user.token);
      expect(response.status, await response.clone().text()).toBe(200);
      const value = await response.json();
      return { text: value.text, toolCalls: value.tool_calls };
    } }, { run: async () => ({ value: { tracks: [{ name: "Pad", notes: [60, 64, 67] }] } }) },
    [{ role: "user", content: "Read this arrangement" }], undefined,
    { turnId, record: async (event) => { expect((await api(`/v1/turns/${turnId}/events`, event, user.token)).status).toBe(200); } });
    expect(out.text).toContain("```note");
    const exported = await (await api("/operator", { action: "export", member_id: user.id, turn_id: turnId }, env.ADMIN_TOKEN)).json();
    expect(exported.complete).toBe(true);
    expect(exported.requests).toHaveLength(2);
    expect((await env.DB.prepare("SELECT spent FROM budget").first()).spent).toBe(2000);
  });
  test("a slow capture store does not withhold a billed answer", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    let release: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const put = env.CAPTURE.put.bind(env.CAPTURE);
    vi.spyOn(env.CAPTURE, "put").mockImplementation(async (...args) => { await stalled; return put(...args); });
    reply();
    const result = await api("/v1/completions", question(), user.token);
    expect(result.status).toBe(200);
    expect((await env.DB.prepare("SELECT incomplete FROM turns").first()).incomplete).toBe(1);
    release!();
    await vi.waitFor(async () => expect((await env.DB.prepare("SELECT state FROM captures").first()).state).toBe("ready"));
  });

  test("capture cleanup cannot extend the answer deadline", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const put = env.CAPTURE.put.bind(env.CAPTURE);
    vi.spyOn(env.CAPTURE, "put").mockImplementation(async (...args) => { await stalled; return put(...args); });
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql === "UPDATE turns SET incomplete = 1 WHERE id = ?") {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          vi.spyOn(bound, "run").mockImplementation(async () => { await stalled; return run(); });
          return bound;
        });
      }
      return statement;
    });
    reply();
    const pending = api("/v1/completions", question(), user.token);
    try {
      const result = await Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(resolve, 2800))]);
      expect(result?.status).toBe(200);
    } finally {
      release();
      await pending;
      await vi.waitFor(async () => {
        expect((await env.DB.prepare("SELECT incomplete FROM turns").first()).incomplete).toBe(1);
        expect((await env.DB.prepare("SELECT state FROM captures").first()).state).toBe("ready");
      });
    }
  });

  test("a D1 restore cannot erase the external deletion journal", async () => {
    const user = await joined();
    await api("/v1/account", undefined, user.token, "DELETE");
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET revoked = 0, deleted_at = NULL"),
      env.DB.prepare("DELETE FROM deletion_jobs"), env.DB.prepare("DELETE FROM operator_actions"),
    ]);
    expect((await env.CAPTURE.list({ prefix: "deletions/" })).objects).toHaveLength(1);
    const result = await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN);
    expect(result.status, await result.clone().text()).toBe(200);
    expect((await env.DB.prepare("SELECT revoked FROM members").first()).revoked).toBe(1);
    expect((await env.DB.prepare("SELECT completed_at FROM deletion_jobs").first()).completed_at).toBeNull();
    expect((await env.DB.prepare("SELECT paused FROM budget").first()).paused).toBe(1);
  });
  test("exports a complete multi-tool turn and identifies missing local evidence", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const request = question();
    const calls = ["call-a", "call-b"].map((id) => ({ id, type: "function", function: { name: "get_arrangement", arguments: "{}" } }));
    reply({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: calls } }] });
    expect((await api("/v1/completions", request, user.token)).status).toBe(200);
    const tool = (id: string) => api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "tool", at: Date.now(),
      data: { round: 1, tool_call_id: id, name: "get_arrangement", arguments: "{}", result: { value: "read result" } } }, user.token);
    await tool("call-a");
    reply();
    expect((await api("/v1/completions", question(2, request.turn_id), user.token)).status).toBe(200);
    await api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "terminal", at: Date.now(), data: { status: "complete" } }, user.token);
    const exported = () => api("/operator", { action: "export", member_id: user.id, turn_id: request.turn_id }, env.ADMIN_TOKEN);
    expect((await (await exported()).json()).complete).toBe(false);
    await tool("call-b");
    const full = await (await exported()).json();
    expect(full).toMatchObject({ complete: true, training_allowed: false, consent_version: "quality-2026-09-12" });
    expect(full.requests).toHaveLength(2);
    expect(full.events).toHaveLength(5);
    await api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "terminal", at: Date.now(), data: { status: "complete", incomplete: true } }, user.token);
    expect((await (await exported()).json()).complete).toBe(false);
  });

  test.each(["音".repeat(4000), "\u0000".repeat(4000)])("feedback accepts the full character limit even when JSON needs more bytes", async (heard) => {
    const user = await joined();
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    const result = await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard, share: true,
    }, user.token);
    expect(result.status, await result.clone().text()).toBe(200);
    expect((await result.json()).saved).toBe(true);
    const objects = await capturedObjects();
    expect(objects).toHaveLength(1);
    expect((await (await env.CAPTURE.get(objects[0].key))!.json()).heard).toBe(heard);
    expect((await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard: heard + "x", share: true,
    }, user.token)).status).toBe(400);
    expect((await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard: "x".repeat(32768), share: true,
    }, user.token)).status).toBe(413);
  });

  test("sharing one outcome does not enable conversation capture", async () => {
    const user = await joined();
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    const feedback = { id: crypto.randomUUID(), outcome: "undone", heard: "The balance got worse.", share: true };
    expect((await (await api(`/v1/turns/${request.turn_id}/feedback`, feedback, user.token)).json()).saved).toBe(true);
    expect((await (await api("/v1/account", undefined, user.token)).json()).capture).toBe(false);
    const objects = await capturedObjects();
    expect(objects).toHaveLength(1);
    expect(await (await env.CAPTURE.get(objects[0].key))!.json()).toMatchObject({ source: "producer", outcome: "undone" });
  });

  test("deletion during an object write cannot recreate captured content", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const request = question();
    const put = env.CAPTURE.put.bind(env.CAPTURE);
    vi.spyOn(env.CAPTURE, "put").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith("deletions/")) return put(...args);
      expect((await api(`/v1/turns/${request.turn_id}/capture`, undefined, user.token, "DELETE")).status).toBe(202);
      return put(...args);
    });
    reply();
    expect((await api("/v1/completions", request, user.token)).status).toBe(200);
    expect(await capturedObjects()).toHaveLength(0);
  });

  test("expiry removes content and account deletion removes identity and sign-in codes", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    reply();
    await api("/v1/completions", question(), user.token);
    await env.DB.prepare("UPDATE turns SET created_at = ?").bind(Date.now() - 31 * DAY).run();
    await maintain(env);
    expect(await capturedObjects()).toHaveLength(0);
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verification").first()).n).toBeGreaterThan(0);
    expect((await api("/v1/account", undefined, user.token, "DELETE")).status).toBe(202);
    expect((await api("/v1/account", undefined, user.token)).status).toBe(401);
    await env.DB.prepare("UPDATE deletion_jobs SET requested_at = ?").bind(Date.now() - 11 * 60_000).run();
    await maintain(env);
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(user.id).first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verification").first()).n).toBe(0);
  });

  test.each([60 * 60_000, 2 * DAY])("new deletions precede tombstones last checked %i ms ago", async (age) => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const old = question();
    reply();
    await api("/v1/completions", old, user.token);
    const original = await env.DB.prepare("SELECT id, object_key FROM captures WHERE turn_id = ?")
      .bind(old.turn_id).first<{ id: string; object_key: string }>();
    await env.DB.batch(Array.from({ length: 100 }, () => {
      const id = crypto.randomUUID();
      return env.DB.prepare(`INSERT INTO captures(id, turn_id, object_key, bytes, body_hash, kind, state, created_at, updated_at)
        SELECT ?, turn_id, ?, bytes, body_hash, kind, 'deleted', created_at, updated_at FROM captures WHERE id = ?`)
        .bind(id, `old-${id}`, original!.id);
    }));
    await api(`/v1/turns/${old.turn_id}/capture`, undefined, user.token, "DELETE");
    await env.CAPTURE.delete(original!.object_key);
    await env.DB.prepare("UPDATE captures SET state = 'deleted', updated_at = ? WHERE turn_id = ?")
      .bind(Date.now() - age, old.turn_id).run();
    const fresh = question();
    reply();
    await api("/v1/completions", fresh, user.token);
    const object = (await capturedObjects())[0];
    await api(`/v1/turns/${fresh.turn_id}/capture`, undefined, user.token, "DELETE");
    const remove = vi.spyOn(env.CAPTURE, "delete");
    await maintain(env);
    expect(await env.CAPTURE.head(object.key), "newly deleted content must take priority").toBeNull();
    expect(remove).toHaveBeenCalledTimes(age < DAY ? 1 : 100);
    await env.CAPTURE.put(original!.object_key, "late write");
    await env.DB.prepare("UPDATE captures SET updated_at = ? WHERE id = ?").bind(Date.now() - 2 * DAY, original!.id).run();
    await maintain(env);
    expect(await env.CAPTURE.head(original!.object_key), "tombstones must still remove late writes").toBeNull();
  });

  test("captures the actual model request and raw answer only after consent", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    reply();
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    const objects = await capturedObjects();
    expect(objects).toHaveLength(1);
    const payload = await (await env.CAPTURE.get(objects[0].key))!.json();
    expect(payload.body).toEqual(sent[0]);
    expect(payload.response.choices[0].message.content).toContain("```note");
  });

  test("withdrawal rejects late events and enabling capture does not include an earlier turn", async () => {
    const user = await joined();
    reply();
    const request = question();
    await api("/v1/completions", request, user.token);
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    const post = () => api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "tool", at: Date.now(), data: { private: "notes" } }, user.token);
    expect((await (await post()).json()).saved).toBe(false);
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-12" }, user.token, "PUT");
    expect((await (await post()).json()).saved).toBe(false);
    expect(await capturedObjects()).toHaveLength(0);
  });

  test("deletes captured content and rejects events from another account", async () => {
    const user = await joined();
    const other = await joined("other@example.com");
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-12" }, user.token, "PUT");
    reply();
    const request = question();
    await api("/v1/completions", request, user.token);
    expect((await api(`/v1/turns/${request.turn_id}/capture`, undefined, other.token, "DELETE")).status).toBe(404);
    expect((await api(`/v1/turns/${request.turn_id}/capture`, undefined, user.token, "DELETE")).status).toBe(202);
    await maintain(env);
    expect(await capturedObjects()).toHaveLength(0);
    const late = await api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "tool", at: Date.now(), data: "late" }, user.token);
    expect((await late.json()).saved).toBe(false);
  });
});
