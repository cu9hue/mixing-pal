import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../src/index";
import { hash, DAY, FIRST_DATA_TIMEOUT, MIN_RUNTIME, MODEL_TIMEOUT, RESPONSE_BUDGET, SETTLE_MARGIN } from "../src/env";
import { admissionDeadline, settle, settleExpired } from "../src/ledger";
import { canDispatch, complete, dispatchStatement } from "../src/completion";
import { redeem } from "../src/account";
import { maintain } from "../src/maintenance";
import { K26, LUNA, MAX_OUTPUT, ModelPolicy, RESERVATION, policyFor, toolNames, worstCase } from "../src/policy";
import sharedTools from "../../shared/tool-names.json";
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

function defaultReply(extra: Record<string, unknown> = {}) {
  return { id: "generation-1", provider: "DeepInfra",
      usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ finish_reason: "stop", message: { content: "raw answer\n```note\n+ heard example\n```" } }], ...extra };
}

function reply(extra: Record<string, unknown> = {}) {
  replies.push(defaultReply(extra));
}

/** Answers a model's endpoints catalog with this response instead of the default one. */
function catalog(p: ModelPolicy, response: () => Response) {
  const network = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) =>
    String(url) === `${provider}/api/v1/models/${p.model}/endpoints` ? response() : network(url, options));
}

// routes() keeps a good catalog for 5 minutes. Each call moves the clock past every catalog kept so far.
let skew = 0;
function pastCatalogCache() {
  const real = Date.now;
  skew += 6 * 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
}

/** The scripted non-stream reply, as OpenRouter would stream it: content, tool calls, finish, then usage. */
function toSse(reply: Record<string, unknown>): string {
  const choice = (reply.choices as { finish_reason?: string | null; message: { content?: string | null; tool_calls?: unknown[] } }[])[0];
  const base = { id: reply.id, provider: reply.provider, model: "moonshotai/kimi-k2.6" };
  const events: object[] = [];
  if (choice.message.content) events.push({ ...base, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }] });
  (choice.message.tool_calls ?? []).forEach((call, index) =>
    events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, ...(call as object) }] }, finish_reason: null }] }));
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? null }] });
  if (reply.usage) events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? null }], usage: reply.usage });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

beforeEach(async () => {
  sent = [];
  replies = [];
  otpSent = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url) === "https://api.resend.com/emails") {
      const body = JSON.parse(String(options?.body));
      const otp = body.text.match(/code is (\d{6})/);
      if (otp) otpSent = otp[1];
      return Response.json({ id: "email-id" });
    }
    if (String(url) === `${provider}/api/v1/models/moonshotai/kimi-k2.6/endpoints`) {
      return Response.json({ data: { endpoints: [
        { tag: "inceptron/int4", status: 0, context_length: 262144,
          pricing: { prompt: "0.0000004344", completion: "0.00000245", input_cache_read: "0.00000012", discount: 0 } },
        // Not on the approved list: an fp4 host is a further quantization than the model was evaluated on.
        { tag: "deepinfra/fp4", status: 0, context_length: 262144, pricing: { prompt: "0.00000075", completion: "0.0000035" } },
        { tag: "venice/int4", status: -5, context_length: 256000, pricing: { prompt: "0.00000075", completion: "0.0000035" } },
      ] } });
    }
    if (String(url) === `${provider}/api/v1/models/openai/gpt-6-luna/endpoints`) {
      // Prices as OpenRouter lists them on 2026-10-26: a higher tier past 272k prompt tokens,
      // cache writes, and a web search price that applies only when a request asks for search.
      const pricing = { prompt: "0.0000001", completion: "0.0000005", web_search: "0.01", input_cache_read: "0.00000001",
        input_cache_write: "0.000000125", discount: 0,
        overrides: [{ min_prompt_tokens: 272000, prompt: "0.0000002", completion: "0.00000075", input_cache_read: "0.00000002", input_cache_write: "0.00000025" }] };
      // A regional Azure host costs 10% more than the global one.
      const regional = { prompt: "0.00000011", completion: "0.00000055", web_search: "0.01", input_cache_read: "0.000000011",
        input_cache_write: "0.0000001375", discount: 0,
        overrides: [{ min_prompt_tokens: 272000, prompt: "0.00000022", completion: "0.000000825", input_cache_read: "0.000000022", input_cache_write: "0.000000275" }] };
      return Response.json({ data: { endpoints: [
        { tag: "azure", status: 0, context_length: 1050000, pricing },
        { tag: "azure/eu", status: 0, context_length: 1050000, pricing: regional },
        // OpenAI's own endpoint keeps data, so it is not an approved route.
        { tag: "openai", status: 0, context_length: 1050000, pricing },
        { tag: "azure/us", status: 0, context_length: 1050000,
          pricing: { ...regional, overrides: [{ ...regional.overrides[0], completion: "0.000002" }] } },
      ] } });
    }
    if (String(url) === `${provider}/api/v1/chat/completions`) {
      sent.push(JSON.parse(String(options?.body)));
      const scripted = replies.shift();
      if (!scripted) throw new Error("No scripted provider response");
      if ("hold" in scripted) await (scripted as { hold: Promise<void> }).hold;
      if ("raw" in scripted) return scripted.raw as Response;
      const reply = "hold" in scripted ? defaultReply() : scripted;
      const headers = new Headers({ "Content-Type": "text/event-stream" });
      if (typeof reply.id === "string") headers.set("X-Generation-Id", reply.id);
      return new Response(toSse(reply), { headers });
    }
    throw new Error(`Unexpected network request: ${String(url)}`);
  });
  // The retention trigger refuses to delete unresolved rows, so reset drops it and puts it back.
  const retention = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'request_retention'").first<{ sql: string }>();
  await env.DB.batch([
    ...(retention ? [env.DB.prepare("DROP TRIGGER request_retention")] : []),
    ...["operator_actions", "deletion_jobs", "captures", "cost_conflicts", "requests", "turns", "consents", "invites", "members", "session", "account", "user", "verification", "rateLimit", "api_limits"]
      .map((table) => env.DB.prepare(`DELETE FROM "${table}"`)),
    ...(retention ? [env.DB.prepare(retention.sql)] : []),
  ]);
  await env.DB.prepare(`UPDATE budget SET spent = 0, reserved = 0, loss = 0, allowance = 50000000,
    paused = 0, recovery_required = 0, capture_bytes = 0, capture_allowance = 4000000000`).run();
  const objects = await env.CAPTURE.list();
  await Promise.all(objects.objects.map((o) => env.CAPTURE.delete(o.key)));
});
afterEach(() => vi.restoreAllMocks());

describe("invited accounts", () => {
  test("operator invitation emails the download link and redeemable code", async () => {
    const before = Date.now();
    const response = await api("/operator", { action: "invite", email: "Producer@example.com" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(200);
    const invite = await response.json();
    expect(invite.email_status).toBe("accepted");
    expect(invite.expires_at).toBeGreaterThanOrEqual(before + 7 * DAY);
    const delivery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "https://api.resend.com/emails");
    expect(delivery).toBeDefined();
    const email = JSON.parse(String(delivery![1]?.body));
    expect(email.to).toEqual(["producer@example.com"]);
    expect(email.from).toBe(env.MAIL_FROM);
    expect(email.subject).toBe("Your Mixing Pal invitation");
    for (const body of [email.html, email.text]) {
      expect(body).toContain(invite.code);
      expect(body).toContain("https://mixingpal.com/beta/");
      expect(body).toContain("seven days");
      expect(body).toContain("six-digit");
    }
    expect(email.html).toContain('src="cid:mixing-pal-logo"');
    expect(email.attachments[0].content_id).toBe("mixing-pal-logo");
    const stored = await env.DB.prepare("SELECT * FROM invites WHERE email = ?").bind("producer@example.com").first();
    expect(stored!.code_hash).toBe(await hash(invite.code));
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    const signed = await api("/auth/sign-in/email-otp", { email: "producer@example.com", otp: otpSent });
    expect(signed.status).toBe(200);
    expect((await api("/v1/invites/redeem", { code: invite.code }, signed.headers.get("set-auth-token")!)).status).toBe(200);
  });

  test.each(["rejection", "timeout"])("invitation email %s reports failure and removes only the new invite", async (failure) => {
    await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
      .bind("existing-invite", "producer@example.com", Date.now() + DAY).run();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return Response.json({ message: "private provider details" }, { status: 403 });
    });
    const response = await api("/operator", { action: "invite", email: "producer@example.com" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "invite_email_failed" } });
    const stored = await env.DB.prepare("SELECT code_hash FROM invites").all();
    expect(stored.results).toEqual([{ code_hash: "existing-invite" }]);
  });

  test("unauthorized operators cannot send invitation emails", async () => {
    expect((await api("/operator", { action: "invite", email: "producer@example.com" }, "wrong-token")).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT * FROM invites").all()).results).toHaveLength(0);
  });

  test("sign-in sends the same usable code in HTML and plain text", async () => {
    await invited();
    const delivery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "https://api.resend.com/emails");
    const email = JSON.parse(String(delivery![1]?.body));
    expect(email.to).toEqual(["producer@example.com"]);
    expect(email.text).toContain(otpSent);
    expect(email.html).toContain(`>${otpSent}</`);
    const logo = email.attachments?.find((attachment: { content_id: string }) => attachment.content_id === "mixing-pal-logo");
    expect(logo).toBeDefined();
    expect(email.html).toContain(`src="cid:${logo.content_id}"`);
    expect(email.html).not.toMatch(/src="https?:/);
    expect(atob(logo.content).slice(0, 8)).toBe("\x89PNG\r\n\x1a\n");
    expect(logo.content_type).toBe("image/png");
  });

  describe("sign-in codes", () => {
    const email = "producer@example.com";
    async function sendCode() {
      await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), email, Date.now() + DAY).run();
      expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
      return otpSent;
    }
    async function signIn(otp: string) {
      const response = await api("/auth/sign-in/email-otp", { email, otp });
      return { status: response.status, body: await response.json() as { error?: { code: string; message: string } } };
    }
    const wrong = (otp: string) => otp === "000000" ? "111111" : "000000";

    test("a resent code is the same code, so the first email still works", async () => {
      const first = await sendCode();
      expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
      expect(otpSent).toBe(first);
      expect((await signIn(first)).status).toBe(200);
    });

    test("two sends at once email one code, and it works", async () => {
      await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), email, Date.now() + DAY).run();
      const responses = await Promise.all([1, 2].map(() => api("/auth/email-otp/send-verification-otp", { email })));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const deliveries = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "https://api.resend.com/emails");
      expect(deliveries).toHaveLength(1);
      expect((await signIn(otpSent)).status).toBe(200);
      expect((await env.DB.prepare("SELECT count(*) AS n FROM sign_in_sends").first<{ n: number }>())!.n).toBe(0);
    });

    test("a code lasts fifteen minutes and the email says so", async () => {
      const before = Date.now();
      await sendCode();
      const row = await env.DB.prepare('SELECT "expiresAt" FROM "verification"').first<{ expiresAt: string }>();
      const lifetime = new Date(row!.expiresAt).getTime() - before;
      expect(lifetime).toBeGreaterThan(14 * 60_000);
      expect(lifetime).toBeLessThanOrEqual(15 * 60_000 + 5_000);
      const delivery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "https://api.resend.com/emails");
      const sentEmail = JSON.parse(String(delivery![1]?.body));
      expect(sentEmail.text).toContain("15 minutes");
      expect(sentEmail.html).toContain("15 minutes");
    });

    test("a code is resent only within 15 minutes of the first email, so it lives 30 minutes at most", async () => {
      const first = await sendCode();
      // The code was first sent 16 minutes ago and a resend since then kept it unexpired.
      await env.DB.prepare('UPDATE "verification" SET "createdAt" = ?')
        .bind(new Date(Date.now() - 16 * 60_000).toISOString()).run();
      expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
      expect(otpSent).not.toBe(first);
      expect((await env.DB.prepare('SELECT count(*) AS n FROM "verification"').first<{ n: number }>())!.n).toBe(1);
      expect((await signIn(first)).status).toBe(400);
      expect((await signIn(otpSent)).status).toBe(200);
    });

    test("the subject carries the code", async () => {
      const otp = await sendCode();
      const delivery = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "https://api.resend.com/emails");
      expect(JSON.parse(String(delivery![1]?.body)).subject).toBe(`${otp} is your Mixing Pal sign-in code`);
    });

    test("an expired code says it expired", async () => {
      const otp = await sendCode();
      await env.DB.prepare('UPDATE "verification" SET "expiresAt" = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
      const result = await signIn(otp);
      expect(result.status).toBe(400);
      expect(result.body.error).toMatchObject({ code: "code_expired" });
      expect(result.body.error!.message).toMatch(/expired/i);
    });

    test("a wrong code says it is wrong", async () => {
      const otp = await sendCode();
      const result = await signIn(wrong(otp));
      expect(result.status).toBe(400);
      expect(result.body.error).toMatchObject({ code: "code_invalid" });
      expect(result.body.error!.message).toMatch(/isn't right/);
    });

    test("a code stored hashed before codes were encrypted gives way to a new one", async () => {
      await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), email, Date.now() + DAY).run();
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO "verification"(id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind("pre-deploy", `sign-in-otp-${email}`, "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg:0",
          new Date(Date.now() + 120_000).toISOString(), now, now).run();
      expect((await signIn("123456")).body.error).toMatchObject({ code: "code_invalid" });
      expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
      expect((await signIn(otpSent)).status).toBe(200);
    });

    test("three wrong codes lock the code and say to request a new one", async () => {
      const otp = await sendCode();
      for (let attempt = 0; attempt < 3; attempt++) await signIn(wrong(otp));
      const result = await signIn(otp);
      expect(result.status).toBe(403);
      expect(result.body.error).toMatchObject({ code: "too_many_attempts" });
      expect(result.body.error!.message).toMatch(/new code/i);
    });
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

test("the timing budget fits a full reply inside the app's 300 s limit", () => {
  expect(MODEL_TIMEOUT).toBeGreaterThanOrEqual((MAX_OUTPUT / 50) * 1000);
  expect(RESPONSE_BUDGET - SETTLE_MARGIN).toBeGreaterThanOrEqual(MODEL_TIMEOUT - 5_000);
  expect(RESPONSE_BUDGET).toBeLessThanOrEqual(300_000 - 15_000);
});

describe("metered requests", () => {
  test("restore requires fresh sharing consent and preserves revoked access", async () => {
    const user = await joined();
    const revoked = await joined("revoked@example.com");
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const sessions = (await env.DB.prepare('SELECT * FROM "session" WHERE userId = ?').bind(revoked.id).all()).results;
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-17" }, user.token, "PUT");
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
    const consent = await (await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT")).json();
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
    reply();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
    reply({ usage: null });
    const provisional = question();
    expect((await api("/v1/completions", provisional, user.token)).status).toBe(200);
    await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN);
    const recover = (spent_micro_usd: number) => api("/operator", { action: "recover", member_id: user.id,
      spent_micro_usd, reason: "Verified recovery amount" }, env.ADMIN_TOKEN);
    expect((await recover(1000)).status).toBe(409);
    await settle(env, provisional.request_id, 500);
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(1000);
    expect((await recover(999)).status).toBe(409);
    await env.DB.exec("CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON operator_actions BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
    try { expect((await recover(1000)).status).toBe(503); }
    finally { await env.DB.exec("DROP TRIGGER fail_recovery_audit"); }
    expect((await env.DB.prepare("SELECT recovery_required FROM members WHERE id = ?").bind(user.id).first()).recovery_required).toBe(1);
    expect((await recover(1000)).status).toBe(200);
  });

  test("five live calls refuse a sixth; five dead calls do not", async () => {
    const holds: (() => void)[] = [];
    const pending = [];
    for (let i = 0; i < 5; i++) {
      const user = await joined(`producer-${i}@example.com`);
      replies.push({ hold: new Promise<void>((r) => holds.push(r)) } as never);
      pending.push(api("/v1/completions", question(), user.token));
    }
    await vi.waitFor(() => expect(sent).toHaveLength(5));
    const waiting = await joined("waiting@example.com");
    expect((await api("/v1/completions", question(), waiting.token)).status).toBe(429);
    await env.DB.prepare("UPDATE requests SET lease_until = 1 WHERE status = 'dispatched'").run();
    reply();
    expect((await api("/v1/completions", question(), waiting.token)).status).toBe(200);
    holds.forEach((h) => h());
    await Promise.all(pending);
  });

  test("measures local completion overhead against the stub provider", async ({ task }) => {
    const user = await joined();
    const overhead: number[] = [];
    for (let i = 0; i < 20; i++) {
      reply();
      const startDirect = performance.now();
      await (await fetch(`${provider}/api/v1/chat/completions`, { method: "POST", body: "{}" })).text();
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
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    await env.DB.prepare("UPDATE requests SET reconcile_after = 0").run();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (!String(url).includes("/generation?")) return original(url, options);
      return Promise.resolve(String(url).endsWith("held-1") ? Response.json({ data: { total_cost: 0.001, finish_reason: "stop" } }) : new Response(null, { status: 404 }));
    });
    await maintain(env);
    expect((await env.DB.prepare("SELECT provisional FROM requests WHERE generation_id = 'held-1'").first())!.provisional).toBe(0);
    expect((await env.DB.prepare("SELECT provisional FROM requests WHERE generation_id = 'held-0'").first())!.provisional).toBe(1);
  });
  test("a cut-off charges the member nothing and admits the next question", async () => {
    const user = await joined();
    replies.push({ raw: new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }),
      { headers: { "X-Generation-Id": "known-generation", "Content-Type": "text/event-stream" } }) } as never);
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("completion_interrupted");
    expect(await env.DB.prepare("SELECT spent, reserved FROM members WHERE id = ?").bind(user.id).first()).toEqual({ spent: 0, reserved: 0 });
    expect(await env.DB.prepare("SELECT spent, reserved FROM budget").first()).toEqual({ spent: RESERVATION, reserved: 0 });
    reply();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
  });

  test("a settlement failure still answers, and the lease cleanup settles the row later", async () => {
    const user = await joined();
    await env.DB.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE OF cost ON requests BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
    try {
      reply();
      expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
      expect((await env.DB.prepare("SELECT status FROM requests").first())!.status).toBe("dispatched");
    } finally { await env.DB.exec("DROP TRIGGER fail_settlement"); }
    await env.DB.prepare("UPDATE requests SET lease_until = 1").run();
    await settleExpired(env, Date.now());
    expect(await env.DB.prepare("SELECT status, provisional FROM requests").first()).toEqual({ status: "settled", provisional: 1 });
  });

  test("never exposes a provider credential in a reply or capture", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    reply({ choices: [{ finish_reason: "stop", message: { content: env.OPENROUTER_KEY } }] });
    const result = await api("/v1/completions", question(), user.token);
    expect(await result.text()).not.toContain(env.OPENROUTER_KEY);
    for (const object of await capturedObjects()) {
      expect(await (await env.CAPTURE.get(object.key))!.text()).not.toContain(env.OPENROUTER_KEY);
    }
  });

  test("never persists or exports a provider credential carried in stream metadata", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const request = question();
    reply({ id: `gen-${env.OPENROUTER_KEY}`, provider: `host-${env.OPENROUTER_KEY}`,
      choices: [{ finish_reason: `stop-${env.OPENROUTER_KEY}`, message: { content: "answer" } }] });
    expect((await api("/v1/completions", request, user.token)).status).toBe(200);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM requests").all()).results)).not.toContain(env.OPENROUTER_KEY);
    const exported = await api("/operator", { action: "export", member_id: user.id, turn_id: request.turn_id }, env.ADMIN_TOKEN);
    expect(exported.status).toBe(200);
    expect(await exported.text()).not.toContain(env.OPENROUTER_KEY);
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
    expect((await api("/v1/completions", question(), second.token)).status).toBe(503);
    expect(sent).toHaveLength(1);
  });
  test("applies server policy and settles actual cost without persisting project content", async () => {
    const user = await joined();
    reply();
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).text).toContain("```note");
    expect(sent[0]).toMatchObject({ model: "moonshotai/kimi-k2.6", max_tokens: 12000, stream: true, reasoning: { effort: "low" },
      provider: { only: ["inceptron/int4"], zdr: true, sort: "throughput" } });
    const row = await env.DB.prepare("SELECT spent, reserved FROM members WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ spent: 1000, reserved: 0 });
    expect(await capturedObjects()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT * FROM requests").all()).results[0].usage).not.toContain("secret project");
  });

  test("serves Luna on zero-retention Azure hosts to an app that sends nullable tool arguments", async () => {
    const user = await joined();
    reply();
    const response = await api("/v1/completions", { ...question(), app_version: "0.2.11" }, user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    // azure/us is left out: its long-prompt completion price is over Luna's cap.
    expect(sent[0]).toMatchObject({ model: "openai/gpt-6-luna", max_tokens: 12000, reasoning: { effort: "low" },
      provider: { only: ["azure", "azure/eu"], zdr: true, sort: "throughput", max_price: { prompt: 0.275, completion: 1 } } });
    expect(await env.DB.prepare("SELECT model, policy_version FROM requests").first())
      .toEqual({ model: "openai/gpt-6-luna", policy_version: LUNA.version });
  });

  test("keeps an app from before nullable tool arguments on K2.6", () => {
    // Without null in the schema, Luna fills every optional argument and its sample reads fail.
    expect(policyFor("0.2.10")).toBe(K26);
    expect(policyFor("0.2.4")).toBe(K26);
    expect(policyFor("0.2.11")).toBe(LUNA);
    expect(policyFor("0.10.0")).toBe(LUNA);
    expect(policyFor("1.0.0")).toBe(LUNA);
  });

  test.each([
    ["Luna has no eligible host", () => Response.json({ data: { endpoints: ["azure", "azure/us", "azure/eu"].map((tag) =>
      ({ tag, status: -2, context_length: 1050000, pricing: { prompt: "0.0000001", completion: "0.0000005" } })) } })],
    ["Luna's catalog cannot be read", () => Response.json({}, { status: 500 })],
  ])("answers with K2.6 when %s", async (_, lunaCatalog) => {
    const user = await joined();
    pastCatalogCache();
    catalog(LUNA, lunaCatalog);
    reply();
    const response = await api("/v1/completions", { ...question(), app_version: "0.2.11" }, user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(sent[0]).toMatchObject({ model: "moonshotai/kimi-k2.6",
      provider: { only: ["inceptron/int4"], max_price: { prompt: 1, completion: 4 } } });
    expect(await env.DB.prepare("SELECT model, policy_version FROM requests").first())
      .toEqual({ model: K26.model, policy_version: K26.version });
  });

  test("never asks for Luna on behalf of an app from before nullable tool arguments", async () => {
    const user = await joined();
    reply();
    expect((await api("/v1/completions", { ...question(), app_version: "0.2.10" }, user.token)).status).toBe(200);
    expect(sent[0]).toMatchObject({ model: "moonshotai/kimi-k2.6" });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).not.toContain(`${provider}/api/v1/models/${LUNA.model}/endpoints`);
  });

  test("reports the model unavailable when neither Luna nor K2.6 has an eligible host", async () => {
    const user = await joined();
    pastCatalogCache();
    catalog(LUNA, () => Response.json({ data: { endpoints: [] } }));
    catalog(K26, () => Response.json({ data: { endpoints: [] } }));
    const response = await api("/v1/completions", { ...question(), app_version: "0.2.11" }, user.token);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({ code: "policy_unavailable", message: "The model is unavailable within the pilot's limits." });
    expect(sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM requests").first())!.n).toBe(0);
  });

  test("reserves enough for either model's most expensive request", () => {
    for (const policy of [K26, LUNA]) expect(worstCase(policy)).toBeLessThanOrEqual(RESERVATION);
  });

  // shared/tool-names.json is pinned to the app's tool schema by a Rust test.
  test("allows exactly the tools the app offers", async () => {
    expect([...toolNames.options].sort()).toEqual([...sharedTools.tools].sort());
    const user = await joined();
    reply();
    const request = question();
    request.body.tools = sharedTools.tools
      .map((name) => ({ type: "function", function: { name, description: "Read the set", parameters: { type: "object" } } }));
    const response = await api("/v1/completions", request, user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(sent[0].tools).toHaveLength(sharedTools.tools.length);
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

  test("missing usage answers, charges the member nothing, and lets the tool round continue", async () => {
    const user = await joined();
    const request = question();
    reply({ usage: null, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
      { id: "call-1", type: "function", function: { name: "get_arrangement", arguments: "{}" } },
    ] } }] });
    const first = await api("/v1/completions", request, user.token);
    expect(first.status).toBe(200);
    expect((await first.json()).tool_calls).toHaveLength(1);
    expect(await env.DB.prepare("SELECT provisional, member_cost FROM requests").first()).toEqual({ provisional: 1, member_cost: 0 });
    reply();
    expect((await api("/v1/completions", question(2, request.turn_id), user.token)).status).toBe(200);
  });
});

describe("never refused because an earlier call went wrong", () => {
  test.each([
    ["5xx before the stream", () => replies.push({ raw: new Response("{}", { status: 503 }) } as never), 502],
    ["error event inside the stream", () => replies.push({ raw: new Response(
      'data: {"id":"g","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\ndata: {"error":{"code":502}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }) } as never), 502],
    ["no scripted reply (network failure)", () => {}, 504],
  ])("%s", async (_, script, status) => {
    const user = await joined();
    script();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(status);
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(0);
    expect((await (await api("/v1/account", undefined, user.token)).json()).can_ask).toBe(true);
    reply();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
  });

  test("a no-charge status with a broken body settles at zero", async () => {
    const user = await joined();
    replies.push({ raw: new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 429 }) } as never);
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("provider_failed");
    expect(await env.DB.prepare("SELECT provisional, cost FROM requests").first()).toEqual({ provisional: 0, cost: 0 });
    expect(await env.DB.prepare("SELECT spent FROM budget").first()).toEqual({ spent: 0 });
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(0);
  });

  test("a refused upstream call logs upstream_failed with its status", async () => {
    const user = await joined();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    replies.push({ raw: new Response("Insufficient credits", { status: 402 }) } as never);
    const request = question();
    expect((await api("/v1/completions", request, user.token)).status).toBe(502);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual({ event: "upstream_failed", request_id: request.request_id, status: 402 });
  });

  test("finish without usage answers and charges the member nothing", async () => {
    const user = await joined();
    reply({ usage: null });
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first()).toEqual({ spent: 0 });
  });

  test("usage then a failure charges the usage and sends no tool calls", async () => {
    const user = await joined();
    replies.push({ raw: new Response(
      'data: {"id":"g","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"get_mixer","arguments":"{"}}]},"finish_reason":null}],"usage":{"cost":0.003,"prompt_tokens":1,"completion_tokens":1}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }) } as never);
    // The stream ends without a finish reason: a truncation, so the producer is told it was interrupted.
    expect((await api("/v1/completions", question(), user.token)).status).toBe(504);
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(3000);
    expect(await env.DB.prepare("SELECT provisional, cost, error_code FROM requests").first())
      .toEqual({ provisional: 0, cost: 3000, error_code: "stream_truncated" });
  });

  test("an error event with empty usage still charges the usage reported before it", async () => {
    const user = await joined();
    replies.push({ raw: new Response(
      'data: {"id":"g","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}],"usage":{"cost":0.003,"prompt_tokens":1,"completion_tokens":1}}\n\n'
      + 'data: {"error":{"code":502},"usage":{}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }) } as never);
    expect((await api("/v1/completions", question(), user.token)).status).toBe(502);
    expect(await env.DB.prepare("SELECT provisional, cost FROM requests").first()).toEqual({ provisional: 0, cost: 3000 });
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(3000);
  });

  test("a provider that sends no headers is cut off at the first-data limit", async () => {
    const user = await joined();
    let signal: AbortSignal | undefined;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (!String(url).endsWith("/chat/completions")) return original(url, options);
      signal = options!.signal!;
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = api("/v1/completions", question(), user.token);
      await vi.waitFor(() => expect(signal).toBeDefined());
      await vi.advanceTimersByTimeAsync(FIRST_DATA_TIMEOUT - 1000);
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(signal!.aborted).toBe(true);
      expect((await pending).status).toBe(504);
    } finally { vi.useRealTimers(); }
    expect(await env.DB.prepare("SELECT provisional, error_code FROM requests").first())
      .toEqual({ provisional: 1, error_code: "provider_interrupted" });
  });

  test("a reply above 1.5 MiB charges its usage, marks the missing capture, and fails", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const event = (choice: object, extra = {}) => `data: ${JSON.stringify({ id: "big", choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
    const half = event({ delta: { content: "a".repeat(800_000) }, finish_reason: null });
    replies.push({ raw: new Response(half + half + event({ delta: {}, finish_reason: "stop" },
      { usage: { cost: 0.002, prompt_tokens: 1, completion_tokens: 1 } }) + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } }) } as never);
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("provider_failed");
    expect(await env.DB.prepare("SELECT provisional, cost, member_cost FROM requests").first())
      .toEqual({ provisional: 0, cost: 2000, member_cost: 2000 });
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(2000);
    // The capture is larger than MAX_BODY, so the turn records that its evidence is missing.
    expect(await capturedObjects()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT incomplete FROM turns").first())!.incomplete).toBe(1);
  });

  test("a header id without any chunk is kept for reconciliation", async () => {
    const user = await joined();
    replies.push({ raw: new Response("", { headers: { "X-Generation-Id": "header-only", "Content-Type": "text/event-stream" } }) } as never);
    expect((await api("/v1/completions", question(), user.token)).status).toBe(504);
    expect(await env.DB.prepare("SELECT generation_id, provisional FROM requests").first()).toEqual({ generation_id: "header-only", provisional: 1 });
  });

  test("a dispatch needs at least MIN_RUNTIME before its deadline", () => {
    expect(canDispatch(MIN_RUNTIME, 0)).toBe(true);
    expect(canDispatch(MIN_RUNTIME - 1, 0)).toBe(false);
  });

  test("a dispatch whose D1 reply comes back too late never starts the provider call", async () => {
    const user = await joined();
    reply();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("SET status = 'dispatched'")) { const later = Date.now() + MODEL_TIMEOUT; vi.spyOn(Date, "now").mockReturnValue(later); }
      return prepare(sql);
    });
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status).toBe(504);
    expect(sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status, provisional, cost, error_code FROM requests").first())
      .toEqual({ status: "settled", provisional: 0, cost: 0, error_code: "not_dispatched" });
  });

  test("the guarded dispatch never moves a row whose deadline is too close, so the provider is never called", async () => {
    const user = await joined();
    const t = crypto.randomUUID(), r = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES (?, ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(t, user.id).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', ?, ?)`)
      .bind(r, t, user.id, RESERVATION, Date.now() + MIN_RUNTIME - 1, Date.now() + MIN_RUNTIME + SETTLE_MARGIN).run();
    expect((await dispatchStatement(env, r, Date.now()).run()).meta.changes).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(r).first())!.status).toBe("reserved");
  });
});

describe("response deadline", () => {
  // Once the call settles, the clock reads 200 ms before the reply is due, and statements matching `match` take 2 s.
  function slowAfterSettling(receivedAt: number, match: string) {
    const prepare = env.DB.prepare.bind(env.DB);
    let stalled: Promise<unknown> = Promise.resolve();
    const slow = (statement: D1PreparedStatement): D1PreparedStatement => {
      const { bind, first, run } = statement;
      const later = (work: () => Promise<unknown>) => (stalled = new Promise((r) => setTimeout(r, 2000)).then(work));
      return Object.assign(statement, { bind: (...values: unknown[]) => slow(bind.apply(statement, values)),
        first: (...args: never[]) => later(() => first.apply(statement, args)), run: () => later(() => run.apply(statement)) });
    };
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sent.length && sql.startsWith("UPDATE requests SET status = 'settled'")) vi.spyOn(Date, "now").mockReturnValue(receivedAt + RESPONSE_BUDGET - 200);
      return sql.includes(match) ? slow(prepare(sql)) : prepare(sql);
    });
    return () => stalled;
  }
  const late = () => new Promise((r) => setTimeout(() => r("late"), 1500));

  test("a slow account read never holds the answer past the response budget", async () => {
    const user = await joined();
    reply();
    const receivedAt = Date.now();
    const stalled = slowAfterSettling(receivedAt, "SELECT paused, recovery_required");
    const answer = complete(env, user.id, question(), createExecutionContext(), receivedAt);
    expect(await Promise.race([answer.then(() => "on time"), late()])).toBe("on time");
    const body = await (await answer).json();
    expect(body.text).toContain("raw answer");
    expect(body.account).toBeUndefined();
    await stalled();
  });

  test("a settlement that misses the response budget still lands after the reply", async () => {
    const user = await joined();
    reply();
    const receivedAt = Date.now();
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (sent.length) {
        vi.spyOn(Date, "now").mockReturnValue(receivedAt + RESPONSE_BUDGET - 200);
        await new Promise((r) => setTimeout(r, 1000));
      }
      return batch(statements);
    });
    const ctx = createExecutionContext();
    expect((await complete(env, user.id, question(), ctx, receivedAt)).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM requests").first())!.status).toBe("dispatched");
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare("SELECT status, provisional, cost FROM requests").first())
      .toEqual({ status: "settled", provisional: 0, cost: 1000 });
  });

  test("a slow failure path never holds the error past the response budget", async () => {
    const user = await joined();
    replies.push({ raw: new Response("{}", { status: 503 }) } as never);
    const receivedAt = Date.now();
    const stalled = slowAfterSettling(receivedAt, "UPDATE turns SET incomplete = 1");
    const answer = complete(env, user.id, question(), createExecutionContext(), receivedAt);
    expect(await Promise.race([answer.then(() => "on time", () => "on time"), late()])).toBe("on time");
    await expect(answer).rejects.toMatchObject({ status: 502 });
    await stalled();
  });
});

describe("pilot stats", () => {
  // One answered model call, then the turn moved to `at`, lasting `seconds`, ending as `status`.
  async function turn(token: string, at: number, seconds: number, status: string) {
    reply({ usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 200 } });
    const request = question();
    expect((await api("/v1/completions", request, token)).status).toBe(200);
    await env.DB.batch([
      env.DB.prepare("UPDATE turns SET created_at = ?, updated_at = ?, status = ? WHERE id = ?").bind(at, at + seconds * 1000, status, request.turn_id),
      env.DB.prepare("UPDATE requests SET created_at = ?, duration_ms = 4000 WHERE turn_id = ?").bind(at, request.turn_id),
    ]);
    return request;
  }

  test("reports retention, speed, failures and hosts without project content", async () => {
    const a = await joined("a@example.com");
    const b = await joined("b@example.com");
    const now = Date.now();
    const yesterday = Math.floor((now - DAY) / DAY) * DAY;
    await turn(a.token, now - 10 * DAY, 10, "complete");
    await turn(a.token, yesterday + 3_600_000, 20, "complete");
    const failed = await turn(a.token, yesterday + 7_200_000, 90, "failed");
    await turn(b.token, now - 2 * DAY, 40, "complete");
    await env.DB.prepare("UPDATE requests SET error_code = 'upstream_429' WHERE turn_id = ?").bind(failed.turn_id).run();
    await turn(b.token, now - 40 * DAY, 5, "complete");

    const response = await api("/operator", { action: "stats" }, env.ADMIN_TOKEN);
    expect(response.status, await response.clone().text()).toBe(200);
    const stats = await response.json() as Record<string, any>;
    expect(stats.days).toBe(28);
    expect(stats.weeks).toEqual([
      { starts: now - 28 * DAY, members: 0, returning: 0, turns: 0 },
      { starts: now - 21 * DAY, members: 0, returning: 0, turns: 0 },
      { starts: now - 14 * DAY, members: 1, returning: 0, turns: 1 },
      { starts: now - 7 * DAY, members: 2, returning: 1, turns: 3 },
    ].map((w) => ({ ...w, starts: expect.any(Number) })));
    expect(stats.turns).toEqual({ total: 4, by_status: { complete: 3, failed: 1 }, incomplete: 0,
      complete_seconds_p50: 20, complete_seconds_p95: 40, per_member_per_active_day_median: 1 });
    expect(stats.errors).toEqual([{ code: "upstream_429", count: 1 }]);
    expect(stats.hosts).toEqual([{ host: "DeepInfra", calls: 4, seconds_median: 4, tokens_per_second_median: 50 }]);
    expect(stats.members).toEqual([
      { id: a.id, turns: 3, active_days: 2, last_seen: yesterday + 7_200_000 },
      { id: b.id, turns: 1, active_days: 1, last_seen: now - 2 * DAY },
    ]);
    expect(JSON.stringify(stats)).not.toContain("secret project");

    const week = await (await api("/operator", { action: "stats", days: 7 }, env.ADMIN_TOKEN)).json() as Record<string, any>;
    expect(week.turns.total).toBe(3);
    // Ten days still count two whole weeks of retention; the totals keep to ten days.
    const ten = await (await api("/operator", { action: "stats", days: 10 }, env.ADMIN_TOKEN)).json() as Record<string, any>;
    expect([ten.weeks.map((w: { turns: number }) => w.turns), ten.turns.total]).toEqual([[1, 3], 3]);
    expect((await api("/operator", { action: "stats", days: 91 }, env.ADMIN_TOKEN)).status).toBe(400);
    expect((await api("/operator", { action: "stats" }, "wrong-token")).status).toBe(401);
  });

  test("an empty pilot reports zeros, not errors", async () => {
    const stats = await (await api("/operator", { action: "stats", days: 7 }, env.ADMIN_TOKEN)).json() as Record<string, any>;
    expect(stats.turns).toEqual({ total: 0, by_status: {}, incomplete: 0,
      complete_seconds_p50: null, complete_seconds_p95: null, per_member_per_active_day_median: null });
    expect([stats.weeks.length, stats.hosts, stats.members, stats.errors]).toEqual([1, [], [], []]);
  });
});

describe("capture and deletion", () => {
  test("the global capture allowance rejects new objects before R2 storage can grow", async () => {
    const user = await joined();
    const consent = await (await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT")).json();
    await env.DB.prepare("UPDATE budget SET capture_allowance = 1").run();
    reply();
    const request = { ...question(), capture_epoch: consent.consent_epoch };
    expect((await api("/v1/completions", request, user.token)).status).toBe(200);
    expect(await capturedObjects()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT capture_bytes FROM budget").first()).toEqual({ capture_bytes: 0 });
    expect(await env.DB.prepare("SELECT incomplete FROM turns WHERE id = ?").bind(request.turn_id).first()).toEqual({ incomplete: 1 });
  });

  test.each([null, undefined, 0])("capture uses the turn-start consent %s, not a later opt-in", async (capture_epoch) => {
    const user = await joined();
    const request = { ...question(), capture_epoch };
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
      await api("/v1/consent", { enabled, version: "quality-2026-09-17" }, user.token, "PUT");
    }
    reply();
    const result = await api("/v1/completions", question(), user.token);
    expect(result.status).toBe(200);
    expect((await result.json()).capture).toBe(false);
    expect(await capturedObjects()).toHaveLength(0);
  });

  test("the app's real tool loop completes through the proxy and exports replayable evidence", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    expect(full).toMatchObject({ complete: true, training_allowed: false, consent_version: "quality-2026-09-17" });
    expect(full.requests).toHaveLength(2);
    expect(full.events).toHaveLength(5);
    await api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "terminal", at: Date.now(), data: { status: "complete", incomplete: true } }, user.token);
    expect((await (await exported()).json()).complete).toBe(false);
  });

  test.each(["音".repeat(4000), "\u0000".repeat(4000)])("feedback accepts the full character limit even when JSON needs more bytes", async (heard) => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    const result = await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard,
    }, user.token);
    expect(result.status, await result.clone().text()).toBe(200);
    expect((await result.json()).saved).toBe(true);
    const reports = await env.DB.prepare("SELECT object_key FROM captures WHERE kind = 'feedback' AND state = 'ready'").all<{ object_key: string }>();
    expect(reports.results).toHaveLength(1);
    expect((await (await env.CAPTURE.get(reports.results[0].object_key))!.json()).heard).toBe(heard);
    expect((await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard: heard + "x",
    }, user.token)).status).toBe(400);
    expect((await api(`/v1/turns/${request.turn_id}/feedback`, {
      id: crypto.randomUUID(), outcome: "kept", heard: "x".repeat(32768),
    }, user.token)).status).toBe(413);
  });

  test("outcome sharing follows account consent, including withdrawal and older turns", async () => {
    const user = await joined();
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    const feedback = { id: crypto.randomUUID(), outcome: "undone", heard: "The balance got worse." };
    expect((await (await api(`/v1/turns/${request.turn_id}/feedback`, feedback, user.token)).json()).saved).toBe(false);
    expect((await (await api(`/v1/turns/${request.turn_id}/feedback`, { ...feedback, id: crypto.randomUUID(), share: true }, user.token)).json()).saved).toBe(false);
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    expect((await (await api(`/v1/turns/${request.turn_id}/feedback`, { ...feedback, id: crypto.randomUUID() }, user.token)).json()).saved).toBe(false);
    const sharedTurn = question();
    reply();
    await api("/v1/completions", sharedTurn, user.token);
    expect((await (await api(`/v1/turns/${sharedTurn.turn_id}/feedback`, { ...feedback, id: crypto.randomUUID() }, user.token)).json()).saved).toBe(true);
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-17" }, user.token, "PUT");
    expect((await (await api(`/v1/turns/${sharedTurn.turn_id}/feedback`, { ...feedback, id: crypto.randomUUID() }, user.token)).json()).saved).toBe(false);
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    expect((await (await api(`/v1/turns/${sharedTurn.turn_id}/feedback`, { ...feedback, id: crypto.randomUUID() }, user.token)).json()).saved).toBe(false);
    const reports = await env.DB.prepare("SELECT object_key FROM captures WHERE kind = 'feedback' AND state = 'ready'").all<{ object_key: string }>();
    expect(reports.results).toHaveLength(1);
    expect(await (await env.CAPTURE.get(reports.results[0].object_key))!.json()).toMatchObject({ source: "producer", outcome: "undone" });
  });

  test("an earlier consent version cannot authorize the expanded sharing setting", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET capture = 1, consent_epoch = 1 WHERE id = ?").bind(user.id).run();
    await env.DB.prepare("INSERT INTO consents(member_id, version, enabled, created_at) VALUES (?, ?, 1, ?)")
      .bind(user.id, "quality-2026-09-12", Date.now()).run();
    expect((await (await api("/v1/account", undefined, user.token)).json()).capture).toBe(false);
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    const turn = await env.DB.prepare("SELECT capture FROM turns WHERE id = ?").bind(request.turn_id).first<{ capture: number }>();
    expect(turn?.capture).toBe(0);
    const feedback = { id: crypto.randomUUID(), outcome: "kept", heard: "It worked." };
    expect((await (await api(`/v1/turns/${request.turn_id}/feedback`, feedback, user.token)).json()).saved).toBe(false);
  });

  test("deletion during an object write cannot recreate captured content", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    reply();
    await api("/v1/completions", question(), user.token);
    await env.DB.prepare("UPDATE turns SET created_at = ?").bind(Date.now() - 31 * DAY).run();
    await maintain(env);
    expect(await capturedObjects()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT capture_bytes FROM budget").first()).toEqual({ capture_bytes: 0 });
    await api("/auth/email-otp/send-verification-otp", { email: "producer@example.com" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verification").first()).n).toBeGreaterThan(0);
    expect((await api("/v1/account", undefined, user.token, "DELETE")).status).toBe(202);
    expect((await api("/v1/account", undefined, user.token)).status).toBe(401);
    await env.DB.prepare("UPDATE deletion_jobs SET requested_at = ?").bind(Date.now() - 11 * 60_000).run();
    await maintain(env);
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(user.id).first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verification").first()).n).toBe(0);
  });

  test.each([60 * 60_000, 2 * DAY])("new deletions precede tombstones and the sweep drains more than one page at age %i", async (age) => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintain(env);
    expect(await env.CAPTURE.head(object.key), "newly deleted content must take priority").toBeNull();
    expect(remove).toHaveBeenCalledTimes(age < DAY ? 1 : 102);
    if (age >= DAY) {
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line))))
        .toContainEqual(expect.objectContaining({ event: "capture_cleanup_backlog", count: 102 }));
    }
    await env.CAPTURE.put(original!.object_key, "late write");
    await env.DB.prepare("UPDATE captures SET updated_at = ? WHERE id = ?").bind(Date.now() - 2 * DAY, original!.id).run();
    await maintain(env);
    expect(await env.CAPTURE.head(original!.object_key), "tombstones must still remove late writes").toBeNull();
  });

  test("captures the actual model request and raw answer only after consent", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    reply();
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status, await response.clone().text()).toBe(200);
    const objects = await capturedObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toMatch(/^captures\//);
    const payload = await (await env.CAPTURE.get(objects[0].key))!.json();
    expect(payload.body).toEqual(sent[0]);
    expect(payload.response.choices[0].message.content).toContain("```note");
  });

  test("repeating a turn deletion does not create billable journal writes", async () => {
    const user = await joined();
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    expect((await api(`/v1/turns/${request.turn_id}/capture`, undefined, user.token, "DELETE")).status).toBe(202);
    expect((await api(`/v1/turns/${request.turn_id}/capture`, undefined, user.token, "DELETE")).status).toBe(202);
    expect((await env.CAPTURE.list({ prefix: "deletions/" })).objects).toHaveLength(1);
  });

  test("withdrawal rejects late events and enabling capture does not include an earlier turn", async () => {
    const user = await joined();
    reply();
    const request = question();
    await api("/v1/completions", request, user.token);
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const post = () => api(`/v1/turns/${request.turn_id}/events`, { id: crypto.randomUUID(), kind: "tool", at: Date.now(), data: { private: "notes" } }, user.token);
    expect((await (await post()).json()).saved).toBe(false);
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-17" }, user.token, "PUT");
    expect((await (await post()).json()).saved).toBe(false);
    expect(await capturedObjects()).toHaveLength(0);
  });

  test("deletes captured content and rejects events from another account", async () => {
    const user = await joined();
    const other = await joined("other@example.com");
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
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

  test("deleting shared advice removes every shared turn but keeps the account and its sharing choice", async () => {
    const user = await joined();
    const other = await joined("other@example.com");
    for (const member of [user, other]) {
      await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, member.token, "PUT");
    }
    const first = question();
    for (const [member, request] of [[user, first], [user, question()], [other, question()]] as const) {
      reply();
      await api("/v1/completions", request, member.token);
    }
    expect(await capturedObjects()).toHaveLength(3);
    expect((await api("/v1/captures", undefined, user.token, "DELETE")).status).toBe(202);
    await maintain(env);
    const left = await capturedObjects();
    expect(left).toHaveLength(1);
    expect(left[0].key).toContain(other.id);
    const late = await api(`/v1/turns/${first.turn_id}/events`, { id: crypto.randomUUID(), kind: "tool", at: Date.now(), data: "late" }, user.token);
    expect((await late.json()).saved).toBe(false);
    const view = await (await api("/v1/account", undefined, user.token)).json();
    expect(view).toMatchObject({ access: "active", capture: true });
    reply();
    await api("/v1/completions", question(), user.token);
    expect(await capturedObjects()).toHaveLength(2);
  });

  test("a restored database replays a shared-advice deletion", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    const request = question();
    reply();
    await api("/v1/completions", request, user.token);
    await api("/v1/captures", undefined, user.token, "DELETE");
    expect((await env.CAPTURE.list({ prefix: "deletions/" })).objects).toHaveLength(1);
    await env.DB.prepare("UPDATE turns SET deleted_at = NULL, capture = 1 WHERE id = ?").bind(request.turn_id).run();
    expect((await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN)).status).toBe(200);
    expect(await env.DB.prepare("SELECT capture, deleted_at IS NOT NULL AS deleted FROM turns WHERE id = ?").bind(request.turn_id).first())
      .toEqual({ capture: 0, deleted: 1 });
    expect(await env.DB.prepare("SELECT deleted_at FROM members WHERE id = ?").bind(user.id).first()).toEqual({ deleted_at: null });
  });

  test("the account says whether the producer has answered the current sharing question", async () => {
    const user = await joined();
    const chosen = async () => (await (await api("/v1/account", undefined, user.token)).json()).sharing_chosen;
    expect(await chosen()).toBe(false);
    await env.DB.prepare("INSERT INTO consents(member_id, version, enabled, created_at) VALUES (?, ?, 1, ?)")
      .bind(user.id, "quality-2026-09-12", Date.now()).run();
    expect(await chosen()).toBe(false);
    await api("/v1/consent", { enabled: false, version: "quality-2026-09-17" }, user.token, "PUT");
    expect(await chosen()).toBe(true);
  });
});

describe("admission", () => {
  test("a new turn supersedes the member's running turn and is admitted while the old call is live", async () => {
    const user = await joined();
    const first = question();
    let release!: () => void;
    replies.push({ hold: new Promise<void>((r) => { release = r; }) } as never);
    const pending = api("/v1/completions", first, user.token);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reply();
    const second = question();
    expect((await api("/v1/completions", second, user.token)).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM turns WHERE id = ?").bind(first.turn_id).first())!.status).toBe("superseded");
    release();
    expect((await pending).status).toBe(200);
    expect((await api("/v1/completions", question(2, first.turn_id), user.token)).status).toBe(409);
  });

  test("a late finish after the lease cleanup finalizes the provisional row and charges the member nothing", async () => {
    const user = await joined();
    let release!: () => void;
    replies.push({ hold: new Promise<void>((r) => { release = r; }) } as never);
    const pending = api("/v1/completions", question(), user.token);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await env.DB.prepare("UPDATE requests SET lease_until = 1").run();
    expect((await (await api("/v1/account", undefined, user.token)).json()).reserved_micro_usd).toBe(0);
    expect(await env.DB.prepare("SELECT provisional, error_code FROM requests").first())
      .toEqual({ provisional: 1, error_code: "worker_interrupted" });
    release();
    expect((await pending).status).toBe(200);
    expect(await env.DB.prepare("SELECT status, provisional, cost, member_cost FROM requests").first())
      .toEqual({ status: "settled", provisional: 0, cost: 1000, member_cost: 0 });
    expect(await env.DB.prepare("SELECT spent, reserved FROM members WHERE id = ?").bind(user.id).first()).toEqual({ spent: 0, reserved: 0 });
    expect(await env.DB.prepare("SELECT spent, reserved FROM budget").first()).toEqual({ spent: 1000, reserved: 0 });
  });

  test("an expired lease is settled provisionally at admission and the member is admitted", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET allowance = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    const stuck = question();
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES (?, ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(stuck.turn_id, user.id).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', 1, 2)`).bind(stuck.request_id, stuck.turn_id, user.id, RESERVATION).run();
    await env.DB.prepare("UPDATE requests SET status = 'dispatched' WHERE id = ?").bind(stuck.request_id).run();
    reply();
    expect((await api("/v1/completions", question(), user.token)).status).toBe(200);
    expect(await env.DB.prepare("SELECT provisional, member_cost FROM requests WHERE id = ?").bind(stuck.request_id).first())
      .toEqual({ provisional: 1, member_cost: 0 });
  });

  test("concurrent admissions with one reservation of headroom", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET allowance = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    reply(); reply();
    const results = await Promise.all([api("/v1/completions", question(), user.token), api("/v1/completions", question(), user.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'superseded'").first())!.n).toBeLessThanOrEqual(1);
  });

  test("global budget exhaustion is reported as a pause", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE budget SET allowance = spent").run();
    const response = await api("/v1/completions", question(), user.token);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("service_paused");
  });

  test("the model deadline shrinks by the time spent before admission", () => {
    expect(admissionDeadline(0, 10_000)).toBe(RESPONSE_BUDGET - SETTLE_MARGIN);
    expect(admissionDeadline(0, 0)).toBe(Math.min(MODEL_TIMEOUT, RESPONSE_BUDGET - SETTLE_MARGIN));
  });
});

describe("account eligibility", () => {
  async function stick(memberId: string, sent = true) {
    const t = crypto.randomUUID(), r = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES (?, ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(t, memberId).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', 1, 2)`).bind(r, t, memberId, RESERVATION).run();
    if (sent) await env.DB.prepare("UPDATE requests SET status = 'dispatched' WHERE id = ?").bind(r).run();
  }

  test("an expired call stops blocking the member on the next account read, without cron", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET allowance = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    await stick(user.id);
    const view = await (await api("/v1/account", undefined, user.token)).json();
    expect(view).toMatchObject({ can_ask: true, reserved_micro_usd: 0 });
  });

  test("another member's expired call stops holding the global budget, without the producer polling or cron", async () => {
    const a = await joined("a@example.com");
    const b = await joined("b@example.com");
    await env.DB.prepare("UPDATE budget SET allowance = ?").bind(RESERVATION + 1000).run();
    await stick(a.id, false);
    expect(await (await api("/v1/account", undefined, b.token)).json()).toMatchObject({ can_ask: true, service_paused: false });
    await stick(a.id, false);
    reply();
    expect((await api("/v1/completions", question(), b.token)).status).toBe(200);
  });

  test("a live hold counts against headroom, and can_ask no longer requires zero reserved", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE members SET reserved = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    expect((await (await api("/v1/account", undefined, user.token)).json()).can_ask).toBe(true);
    await env.DB.prepare("UPDATE members SET allowance = ? WHERE id = ?").bind(RESERVATION, user.id).run();
    expect((await (await api("/v1/account", undefined, user.token)).json()).can_ask).toBe(false);
  });

  test("global budget shortfall reads as paused", async () => {
    const user = await joined();
    await env.DB.prepare("UPDATE budget SET allowance = spent + ?").bind(RESERVATION - 1).run();
    expect(await (await api("/v1/account", undefined, user.token)).json()).toMatchObject({ can_ask: false, service_paused: true });
  });

  test("a cleanup failure does not break the account read", async () => {
    const user = await joined();
    await stick(user.id);
    await env.DB.exec("CREATE TRIGGER fail_cleanup BEFORE UPDATE OF status ON requests BEGIN SELECT RAISE(ABORT, 'unavailable'); END");
    try {
      const response = await api("/v1/account", undefined, user.token);
      expect(response.status).toBe(200);
      expect((await response.json()).reserved_micro_usd).toBe(RESERVATION);
    } finally { await env.DB.exec("DROP TRIGGER fail_cleanup"); }
  });
});

describe("maintenance billing", () => {
  test("reconciliation needs completion evidence", async () => {
    const user = await joined();
    reply({ id: "gen-a", usage: null });
    await api("/v1/completions", question(), user.token);
    await env.DB.prepare("UPDATE requests SET reconcile_after = 0").run();
    const original = globalThis.fetch;
    let body: unknown = { data: { total_cost: 0.002 } };
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => String(url).includes("/generation?")
      ? Promise.resolve(Response.json(body)) : original(url, options));
    await maintain(env);
    expect((await env.DB.prepare("SELECT provisional FROM requests").first())!.provisional).toBe(1);
    body = { data: { total_cost: 0.002, finish_reason: "stop" } };
    await env.DB.prepare("UPDATE requests SET reconcile_after = 0").run();
    await maintain(env);
    expect(await env.DB.prepare("SELECT provisional, cost FROM requests").first()).toEqual({ provisional: 0, cost: 2000 });
  });

  test("a cancelled generation with no finish reason is terminal evidence", async () => {
    const user = await joined();
    reply({ id: "gen-c", usage: null });
    await api("/v1/completions", question(), user.token);
    await env.DB.prepare("UPDATE requests SET reconcile_after = 0").run();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => String(url).includes("/generation?")
      ? Promise.resolve(Response.json({ data: { total_cost: 0.002, cancelled: true } })) : original(url, options));
    await maintain(env);
    expect(await env.DB.prepare("SELECT provisional, cost FROM requests").first()).toEqual({ provisional: 0, cost: 2000 });
  });

  test("a refused reconciliation is logged; a missing generation is not", async () => {
    const user = await joined();
    reply({ id: "gen-401", usage: null }); await api("/v1/completions", question(), user.token);
    reply({ id: "gen-404", usage: null }); await api("/v1/completions", question(), user.token);
    await env.DB.prepare("UPDATE requests SET reconcile_after = 0").run();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => String(url).includes("/generation?")
      ? Promise.resolve(new Response(null, { status: String(url).endsWith("gen-401") ? 401 : 404 })) : original(url, options));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintain(env);
    const id = async (generation: string) => (await env.DB.prepare("SELECT id FROM requests WHERE generation_id = ?").bind(generation).first())!.id;
    const failures = logged.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.event === "reconciliation_failed");
    expect(failures).toEqual([{ event: "reconciliation_failed", request_id: await id("gen-401"), status: 401 }]);
  });

  test("billing runs even when report maintenance fails", async () => {
    const user = await joined();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES ('t-old', ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(user.id).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES ('r-old', 't-old', ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', 1, 2)`).bind(user.id, RESERVATION).run();
    await env.DB.prepare("UPDATE requests SET status = 'dispatched' WHERE id = 'r-old'").run();
    // Hiding the table makes maintainReports throw "no such table".
    await env.DB.exec("ALTER TABLE support_reports RENAME TO support_reports_hidden");
    try { await maintain(env); }
    finally { await env.DB.exec("ALTER TABLE support_reports_hidden RENAME TO support_reports"); }
    expect((await env.DB.prepare("SELECT provisional FROM requests WHERE id = 'r-old'").first())!.provisional).toBe(1);
  });

  test("pruning keeps provisional and conflicted turns and removes resolved conflicts first", async () => {
    const user = await joined();
    reply({ usage: null }); const kept = question(); await api("/v1/completions", kept, user.token);
    reply(); const pruned = question(); await api("/v1/completions", pruned, user.token);
    const prunedId = (await env.DB.prepare("SELECT id FROM requests WHERE turn_id = ?").bind(pruned.turn_id).first())!.id;
    await env.DB.prepare("INSERT INTO cost_conflicts(request_id, source, recorded, reported, created_at, resolved_at, resolution) VALUES (?, 'operator', 1000, 900, 1, 2, 'dismissed')").bind(prunedId).run();
    await env.DB.prepare("UPDATE turns SET created_at = 0, deleted_at = 1").run();
    await maintain(env);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM turns WHERE id = ?").bind(kept.turn_id).first())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM turns WHERE id = ?").bind(pruned.turn_id).first())!.n).toBe(0);
  });

  test("a conflict opened while its turn is pruned survives with the request, and pruning goes on", async () => {
    const user = await joined();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 2; i++) { reply(); await api("/v1/completions", question(), user.token); }
    await env.DB.prepare("UPDATE turns SET created_at = 0, deleted_at = 1").run();
    // The conflict lands after the eligibility read, just before the first turn's pruning batch.
    const prepare = env.DB.prepare.bind(env.DB), batch = env.DB.batch.bind(env.DB);
    let pruning: string | undefined, raced: string | undefined;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("DELETE FROM cost_conflicts")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (turnId: string) => { pruning = turnId; return bind(turnId); };
      return statement;
    });
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (pruning && !raced) {
        raced = pruning;
        await prepare(`INSERT INTO cost_conflicts(request_id, source, recorded, reported, created_at)
          SELECT id, 'generation', cost, cost + 1, 1 FROM requests WHERE turn_id = ?`).bind(raced).run();
      }
      return batch(statements);
    });
    await maintain(env);
    vi.restoreAllMocks();
    expect(raced).toBeDefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE turn_id = ?").bind(raced).first())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cost_conflicts WHERE resolved_at IS NULL").first())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM turns").first())!.n).toBe(1);
  });

  test("health reports provisional usage", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintain(env);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({ event: "provisional_usage", count: 1, amount: RESERVATION, without_id: 0 }));
  });
  test("health reports a loss or a pause even with no provisional rows", async () => {
    await env.DB.prepare("UPDATE budget SET loss = 5, paused = 1").run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintain(env);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({ event: "provisional_usage", count: 0, loss: 5, paused: 1 }));
  });
});

describe("operator tools", () => {
  test("usage lists provisional rows and open conflicts", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const usage = await (await api("/operator", { action: "usage" }, env.ADMIN_TOKEN)).json();
    expect(usage.pending[0]).toMatchObject({ provisional: 1, cost: RESERVATION, reserved: RESERVATION });
    expect(usage.conflicts).toEqual([]);
  });

  test("resolve twice reports already_final and books nothing", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    const resolve = () => api("/operator", { action: "resolve", request_id: id, cost_micro_usd: 4000, reason: "From OpenRouter activity" }, env.ADMIN_TOKEN);
    expect(await (await resolve()).json()).toEqual({ outcome: "applied" });
    const again = await resolve();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ outcome: "already_final" });
    expect((await env.DB.prepare("SELECT spent FROM budget").first())!.spent).toBe(4000);
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_actions WHERE action = 'resolve'").first())!.n).toBe(1);
  });

  test("a resolve above the reservation reports that the service paused", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    const response = await api("/operator", { action: "resolve", request_id: id, cost_micro_usd: RESERVATION + 1,
      reason: "From OpenRouter activity" }, env.ADMIN_TOKEN);
    expect(await response.json()).toEqual({ outcome: "applied", paused: true });
    expect((await env.DB.prepare("SELECT paused FROM budget").first())!.paused).toBe(1);
  });

  test("two resolves in the same millisecond audit only the one that applied", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    // Both commands read the row as provisional before either batch runs.
    const batch = env.DB.batch.bind(env.DB);
    let first: (() => void) | undefined;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!first) await new Promise<void>((r) => { first = r; });
      else first();
      return batch(statements);
    });
    const resolve = (cost: number) => api("/operator", { action: "resolve", request_id: id, cost_micro_usd: cost, reason: `Applied ${cost}` }, env.ADMIN_TOKEN);
    const outcomes = await Promise.all([resolve(4000), resolve(9000)]);
    expect(outcomes.map((r) => r.status)).toEqual([200, 200]);
    const cost = (await env.DB.prepare("SELECT cost FROM requests WHERE id = ?").bind(id).first())!.cost;
    expect((await env.DB.prepare("SELECT detail FROM operator_actions WHERE action = 'resolve'").all()).results)
      .toEqual([{ detail: `Applied ${cost}` }]);
  });

  test("two conflict resolutions in the same millisecond audit only the one that applied", async () => {
    const user = await joined();
    reply(); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    await settle(env, id, 5000, {}, "generation");
    const conflict = (await env.DB.prepare("SELECT id FROM cost_conflicts").first())!.id;
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (const resolution of ["booked", "dismissed"]) {
      await api("/operator", { action: "conflict", conflict_id: conflict, resolution, reason: "Provider confirmed" }, env.ADMIN_TOKEN);
    }
    expect((await env.DB.prepare("SELECT detail FROM operator_actions WHERE action = 'conflict'").all()).results)
      .toEqual([{ detail: "booked: Provider confirmed" }]);
  });

  test("resolve_without_id finalizes only the provisional rows without a generation id, once", async () => {
    const user = await joined();
    // With no scripted reply the provider fetch rejects before headers, so these rows have no generation id.
    const lost = [question(), question()];
    for (const q of lost) await api("/v1/completions", q, user.token);
    const withId = question(); reply({ usage: null }); await api("/v1/completions", withId, user.token);
    const final = question(); reply(); await api("/v1/completions", final, user.token);
    const open = question();
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES (?, ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(open.turn_id, user.id).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', 1, 2)`).bind(open.request_id, open.turn_id, user.id, RESERVATION).run();
    const resolve = () => api("/operator", { action: "resolve_without_id", cost_micro_usd: 4000, reason: "From OpenRouter billing" }, env.ADMIN_TOKEN);
    expect(await (await resolve()).json()).toEqual({ outcome: "applied", resolved: 2 });
    const row = (q: { request_id: string }) => env.DB.prepare("SELECT status, provisional, cost, error_code FROM requests WHERE id = ?")
      .bind(q.request_id).first();
    for (const q of lost) expect(await row(q)).toEqual({ status: "settled", provisional: 0, cost: 4000, error_code: "operator_resolved" });
    expect(await row(withId)).toMatchObject({ status: "settled", provisional: 1, cost: RESERVATION });
    expect(await row(final)).toMatchObject({ status: "settled", provisional: 0, cost: 1000 });
    expect(await row(open)).toMatchObject({ status: "reserved" });
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(1000);
    expect((await env.DB.prepare("SELECT spent FROM budget").first())!.spent).toBe(1000 + RESERVATION + 2 * 4000);
    const audit = async () => (await env.DB.prepare("SELECT action, target, detail FROM operator_actions ORDER BY target").all()).results;
    const expected = lost.map((q) => ({ action: "resolve", target: q.request_id, detail: "From OpenRouter billing" }))
      .sort((x, y) => x.target.localeCompare(y.target));
    expect(await audit()).toEqual(expected);
    expect(await (await resolve()).json()).toEqual({ outcome: "applied", resolved: 0 });
    expect(await audit()).toEqual(expected);
  });

  test("resolve answers not_found for an unknown request", async () => {
    const response = await api("/operator", { action: "resolve", request_id: crypto.randomUUID(), cost_micro_usd: 1000, reason: "No such call" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  // Reconciliation finalizes the request and pruning deletes it right after resolve's first read.
  function pruneAfterFirstRead(id: string) {
    const prepare = env.DB.prepare.bind(env.DB);
    let pruned = false;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (pruned || !sql.startsWith("SELECT status, provisional, cost, reserved FROM requests")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = (async () => {
          const row = await first();
          pruned = true;
          await prepare("UPDATE requests SET status = 'settled', provisional = 0, cost = 2000 WHERE id = ? AND provisional = 1").bind(id).run();
          await prepare("DELETE FROM requests WHERE id = ?").bind(id).run();
          return row;
        }) as never;
        return bound;
      };
      return statement;
    });
  }

  test("resolve answers not_found when the request is pruned between its reads", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first<{ id: string }>())!.id;
    pruneAfterFirstRead(id);
    const response = await api("/operator", { action: "resolve", request_id: id, cost_micro_usd: 4000, reason: "From OpenRouter activity" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_actions").first())!.n).toBe(0);
  });

  test("resolve answers not_found when the request is pruned before its conflict is recorded", async () => {
    const user = await joined();
    reply(); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first<{ id: string }>())!.id;
    pruneAfterFirstRead(id);
    const response = await api("/operator", { action: "resolve", request_id: id, cost_micro_usd: 9000, reason: "From OpenRouter activity" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cost_conflicts").first())!.n).toBe(0);
  });

  test("resolve with a different cost on a final row records a conflict and changes nothing", async () => {
    const user = await joined();
    reply({ usage: null }); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    const resolve = (cost: number) => api("/operator", { action: "resolve", request_id: id, cost_micro_usd: cost, reason: "From OpenRouter activity" }, env.ADMIN_TOKEN);
    await resolve(4000);
    const response = await resolve(9000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "conflict" });
    expect(await env.DB.prepare("SELECT source, recorded, reported FROM cost_conflicts WHERE request_id = ?").bind(id).first())
      .toEqual({ source: "operator", recorded: 4000, reported: 9000 });
    expect((await env.DB.prepare("SELECT cost FROM requests WHERE id = ?").bind(id).first())!.cost).toBe(4000);
    expect((await env.DB.prepare("SELECT spent FROM members WHERE id = ?").bind(user.id).first())!.spent).toBe(0);
  });

  test("resolve refuses a request that has not ended", async () => {
    const user = await joined();
    const open = question();
    await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
      VALUES (?, ?, 0, 0, '0.2.9', 14, 0, 0)`).bind(open.turn_id, user.id).run();
    await env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash, policy_version,
      reserved, status, created_at, updated_at, model, deadline, lease_until)
      VALUES (?, ?, ?, 1, 'b', 'p', 't', 'v', ?, 'reserved', 0, 0, 'm', 1, 2)`).bind(open.request_id, open.turn_id, user.id, RESERVATION).run();
    const response = await api("/operator", { action: "resolve", request_id: open.request_id, cost_micro_usd: 1000, reason: "Too early" }, env.ADMIN_TOKEN);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("request_not_provisional");
  });

  test("a booked higher conflict adds the liability once and allows resume", async () => {
    const user = await joined();
    reply(); await api("/v1/completions", question(), user.token);
    const id = (await env.DB.prepare("SELECT id FROM requests").first())!.id;
    await settle(env, id, 5000, {}, "generation");
    expect((await api("/operator", { action: "pause", paused: false }, env.ADMIN_TOKEN)).status).toBe(409);
    const conflict = (await env.DB.prepare("SELECT id FROM cost_conflicts").first())!.id;
    const book = () => api("/operator", { action: "conflict", conflict_id: conflict, resolution: "booked", reason: "Provider confirmed" }, env.ADMIN_TOKEN);
    expect(await (await book()).json()).toEqual({ outcome: "applied" });
    expect(await (await book()).json()).toEqual({ outcome: "already_resolved" });
    expect((await env.DB.prepare("SELECT spent FROM budget").first())!.spent).toBe(5000);
    expect((await api("/operator", { action: "pause", paused: false }, env.ADMIN_TOKEN)).status).toBe(200);
  });

  test("export marks provisional requests", async () => {
    const user = await joined();
    await api("/v1/consent", { enabled: true, version: "quality-2026-09-17" }, user.token, "PUT");
    reply({ usage: null }); const request = question(); await api("/v1/completions", request, user.token);
    const exported = await (await api("/operator", { action: "export", member_id: user.id, turn_id: request.turn_id }, env.ADMIN_TOKEN)).json();
    expect(exported.requests[0].provisional).toBe(1);
  });
});
