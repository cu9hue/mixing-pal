import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/index";
import { DAY, hash } from "../src/env";
import { maintain } from "../src/maintenance";

let otp = "";
let emails: { body: any; key: string | null }[];
let emailStatus = 200;
async function api(path: string, body?: unknown, token?: string, method = body === undefined ? "GET" : "POST") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8787${path}`, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function user(email = "producer@example.com", redeem = true) {
  const code = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)").bind(await hash(code), email, Date.now() + DAY).run();
  expect((await api("/auth/email-otp/send-verification-otp", { email })).status).toBe(200);
  const signed = await api("/auth/sign-in/email-otp", { email, otp });
  const token = signed.headers.get("set-auth-token")!;
  const id = (await signed.json()).user.id;
  if (redeem) expect((await api("/v1/invites/redeem", { code }, token)).status).toBe(200);
  return { id, token };
}
function report() {
  return { id: crypto.randomUUID(), origin: "error", turn_id: crypto.randomUUID(), description: "The answer disappeared.",
    app_version: "0.2.7", wire_version: 13, diagnostics_consent: null };
}
async function objects() { return (await env.CAPTURE.list({ prefix: "reports/" })).objects; }

beforeEach(async () => {
  emails = []; emailStatus = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url) !== "https://api.resend.com/emails") throw new Error("Unexpected external request");
    const body = JSON.parse(String(options?.body));
    const match = body.text.match(/code is (\d{6})/);
    if (match) { otp = match[1]; return Response.json({ id: "otp" }); }
    emails.push({ body, key: new Headers(options?.headers).get("Idempotency-Key") });
    return Response.json({ id: "report-email" }, { status: emailStatus });
  });
  if (await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'support_reports'").first()) {
    await env.DB.prepare("DELETE FROM support_reports").run();
  }
  await env.DB.batch(["operator_actions", "deletion_jobs", "captures", "requests", "turns", "consents", "invites", "members", "session", "account", "user", "verification", "rateLimit", "api_limits"]
    .map((table) => env.DB.prepare(`DELETE FROM "${table}"`)));
  await env.DB.prepare("UPDATE budget SET spent = 0, reserved = 0, paused = 0, recovery_required = 0, capture_bytes = 0, capture_allowance = 4000000000").run();
  for (const o of (await env.CAPTURE.list()).objects) await env.CAPTURE.delete(o.key);
});
afterEach(() => vi.restoreAllMocks());

test("accepts a failed local turn without quality sharing or available inference", async () => {
  const u = await user();
  await env.DB.prepare("UPDATE members SET allowance = 0, period_end = 0 WHERE id = ?").bind(u.id).run();
  await env.DB.prepare("UPDATE budget SET paused = 1").run();
  const r = report();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  expect(await (await api(`/v1/reports/${r.id}`, undefined, u.token)).json()).toMatchObject({ id: r.id, status: "received" });
  expect((await env.DB.prepare("SELECT capture FROM members WHERE id = ?").bind(u.id).first())?.capture).toBe(0);
  const stored = await (await env.CAPTURE.get((await objects())[0].key))!.json() as any;
  expect(stored.report.description).toBe("The answer disappeared.");
  expect(stored.report.diagnostics).toBeUndefined();
});

test("permits a verified invited user before invitation redemption", async () => {
  const u = await user("invited@example.com", false);
  expect((await api("/v1/reports", report(), u.token)).status).toBe(201);
});

test("requires incident consent and rejects client email identity and excess bytes", async () => {
  const u = await user();
  const r = report();
  const diagnostics = { format: "mixing-pal-incident-v1", steps: [], limitations: [] };
  expect((await api("/v1/reports", { ...r, diagnostics }, u.token)).status).toBe(400);
  expect((await api("/v1/reports", { ...r, reply_to: "attacker@example.com" }, u.token)).status).toBe(400);
  expect((await api("/v1/reports", { ...r, description: " " }, u.token)).status).toBe(400);
  expect((await api("/v1/reports", { ...r, description: "x".repeat(330000) }, u.token)).status).toBe(413);
  expect((await api("/v1/reports", { ...r, description: "音".repeat(4000), diagnostics,
    diagnostics_consent: "support-2026-10-03" }, u.token)).status).toBe(201);
});

test("retries the same report without another allowance slot and rejects conflicts", async () => {
  const u = await user(); const r = report();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  expect((await api("/v1/reports", r, u.token)).status).toBe(200);
  expect((await api("/v1/reports", { ...r, description: "changed" }, u.token)).status).toBe(409);
  for (let i = 0; i < 4; i++) expect((await api("/v1/reports", report(), u.token)).status).toBe(201);
  expect((await api("/v1/reports", report(), u.token)).status).toBe(429);
  expect((await api("/v1/reports", r, u.token)).status).toBe(200);
});

test("enforces report and turn ownership and rejects deleted turn attachments", async () => {
  const a = await user(); const b = await user("other@example.com"); const r = report();
  expect((await api("/v1/reports", r, a.token)).status).toBe(201);
  expect((await api(`/v1/reports/${r.id}`, undefined, b.token)).status).toBe(404);
  expect((await api("/v1/reports", r, b.token)).status).toBe(404);
  await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
    VALUES (?, ?, ?, ?, '0.2.7', 13, 0, 0)`).bind(r.turn_id, a.id, Date.now(), Date.now()).run();
  expect((await api("/v1/reports", { ...report(), turn_id: r.turn_id }, b.token)).status).toBe(404);
  await env.DB.prepare("UPDATE turns SET deleted_at = ? WHERE id = ?").bind(Date.now(), r.turn_id).run();
  expect((await api("/v1/reports", { ...report(), turn_id: r.turn_id }, a.token)).status).toBe(410);
});

test("cancel before upload and repeated deletion cannot resurrect a report", async () => {
  const u = await user(); const r = report();
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token, "DELETE")).status).toBe(202);
  expect((await api("/v1/reports", r, u.token)).status).toBe(410);
  const other = report();
  expect((await api("/v1/reports", other, u.token)).status).toBe(201);
  for (let i = 0; i < 2; i++) expect((await api(`/v1/reports/${other.id}`, undefined, u.token, "DELETE")).status).toBe(202);
  expect((await api(`/v1/reports/${other.id}`, undefined, u.token)).status).toBe(410);
  await maintain(env);
  expect(await objects()).toHaveLength(0);
  expect((await env.DB.prepare("SELECT capture_bytes FROM budget").first())?.capture_bytes).toBe(0);
});

test("expires report contents after thirty days", async () => {
  const u = await user(); const r = report();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  await env.DB.prepare("UPDATE support_reports SET accepted_at = ? WHERE id = ?").bind(Date.now() - 31 * DAY, r.id).run();
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(410);
  await maintain(env);
  expect(await objects()).toHaveLength(0);
});

test("reserves the shared byte budget atomically", async () => {
  const u = await user();
  await env.DB.prepare("UPDATE budget SET capture_allowance = 1000").run();
  const results = await Promise.all([api("/v1/reports", { ...report(), description: "x".repeat(500) }, u.token), api("/v1/reports", { ...report(), description: "y".repeat(500) }, u.token)]);
  expect(results.filter(r => r.status === 201).length).toBeLessThanOrEqual(1);
  expect(results.some(r => r.status === 503)).toBe(true);
  expect((await env.DB.prepare("SELECT capture_bytes FROM budget").first())!.capture_bytes).toBeLessThanOrEqual(1000);
});

test("a delete racing the object write blocks acceptance and removes the late object", async () => {
  const u = await user(); const r = report();
  const put = env.CAPTURE.put.bind(env.CAPTURE);
  vi.spyOn(env.CAPTURE, "put").mockImplementation(async (key, value, options) => {
    if (key.startsWith("reports/")) {
      expect((await api(`/v1/reports/${r.id}`, undefined, u.token, "DELETE")).status).toBe(202);
    }
    return put(key, value, options);
  });
  expect((await api("/v1/reports", r, u.token)).status).toBe(409);
  expect(await objects()).toHaveLength(0);
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(410);
});

test("an interrupted storage write resumes without a second reservation", async () => {
  const u = await user(); const r = report();
  vi.spyOn(env.CAPTURE, "put").mockRejectedValueOnce(new Error("R2 unavailable"));
  expect((await api("/v1/reports", r, u.token)).status).toBe(503);
  const before = (await env.DB.prepare("SELECT capture_bytes FROM budget").first())!.capture_bytes;
  expect((await api("/v1/reports", r, u.token)).status).toBe(200);
  expect((await env.DB.prepare("SELECT capture_bytes FROM budget").first())!.capture_bytes).toBe(before);
  expect(await objects()).toHaveLength(1);
});

test("quality capture expiry preserves a newer report but explicit turn deletion removes it", async () => {
  const u = await user(); const r = report(); const now = Date.now();
  await env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
    VALUES (?, ?, ?, ?, '0.2.7', 13, 0, 0)`).bind(r.turn_id, u.id, now - 31 * DAY, now).run();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  await maintain(env);
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(200);
  expect((await api(`/v1/turns/${r.turn_id}/capture`, undefined, u.token, "DELETE")).status).toBe(202);
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(410);
  await env.DB.prepare("UPDATE support_reports SET state = 'ready' WHERE id = ?").bind(r.id).run();
  await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN);
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(410);
});

test("account deletion removes report data for unredeemed accounts too", async () => {
  const u = await user("unredeemed@example.com", false); const r = report();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  expect((await api("/v1/account", undefined, u.token, "DELETE")).status).toBe(202);
  await maintain(env);
  expect(await objects()).toHaveLength(0);
});

test("replaying the deletion journal suppresses a restored report", async () => {
  const u = await user(); const r = report();
  expect((await api("/v1/reports", r, u.token)).status).toBe(201);
  await api(`/v1/reports/${r.id}`, undefined, u.token, "DELETE");
  await env.DB.prepare("UPDATE support_reports SET state = 'ready', mail_state = 'pending' WHERE id = ?").bind(r.id).run();
  expect((await api("/operator", { action: "replay_deletions" }, env.ADMIN_TOKEN)).status).toBe(200);
  expect((await api(`/v1/reports/${r.id}`, undefined, u.token)).status).toBe(410);
  await maintain(env);
  expect(await objects()).toHaveLength(0);
});

test("a storage retry starts retention when the report is accepted", async () => {
  const u = await user(); const r = report();
  vi.spyOn(env.CAPTURE, "put").mockRejectedValueOnce(new Error("storage unavailable"));
  expect((await api("/v1/reports", r, u.token)).status).toBe(503);
  await env.DB.prepare("UPDATE support_reports SET created_at = ? WHERE id = ?").bind(Date.now() - 6 * DAY, r.id).run();
  expect((await api("/v1/reports", r, u.token)).status).toBe(200);
  const row = await env.DB.prepare("SELECT * FROM support_reports WHERE id = ?").bind(r.id).first();
  expect(row!.accepted_at).toBeGreaterThan(Date.now() - 10000);
});
