import { z } from "zod";
import { account, consent, rateLimit, redeem } from "./account";
import { admin } from "./admin";
import { auth, authenticate } from "./auth";
import { deleteAccount, deleteTurn, event, feedback } from "./capture";
import { complete } from "./completion";
import { ApiError, Env, MAX_FEEDBACK_BODY, json, privateHash, readJson } from "./env";
import { maintain } from "./maintenance";

async function authRequest(request: Request, env: Env, path: string): Promise<Response> {
  const allowed = ["/auth/email-otp/send-verification-otp", "/auth/sign-in/email-otp", "/auth/sign-out", "/auth/get-session"];
  if (!allowed.includes(path)) throw new ApiError(404, "not_found", "Not found.");
  if (path === "/auth/get-session") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Use GET.");
  } else if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST.");
  if (path.includes("email-otp")) {
    const raw = await readJson(request, 4096);
    const input = z.object({ email: z.email().transform((s) => s.toLowerCase()), otp: z.string().regex(/^\d{6}$/).optional() }).parse(raw);
    await rateLimit(env, `email:${await privateHash(env.AUTH_SECRET, input.email)}`, path.includes("send-verification") ? 3 : 10, 60_000);
    const eligible = await env.DB.prepare(`SELECT 1 FROM invites WHERE email = ? AND expires_at > ? AND redeemed_by IS NULL
      UNION SELECT 1 FROM "user" u JOIN members m ON u.id = m.id
      WHERE lower(u.email) = ? AND m.deleted_at IS NULL LIMIT 1`)
      .bind(input.email, Date.now(), input.email).first();
    if (!eligible) {
      if (path.includes("send-verification")) return json({ success: true });
      throw new ApiError(401, "sign_in_failed", "The code is invalid or expired. Check your invitation email.");
    }
    const headers = new Headers(request.headers);
    headers.delete("Cookie");
    request = new Request(request.url, { method: "POST", headers,
      body: JSON.stringify(path.includes("send-verification") ? { email: input.email, type: "sign-in" } : input) });
  }
  const response = await auth(env).handler(request);
  if (!response.ok) {
    await response.body?.cancel();
    return json({ error: { code: "sign_in_failed", message: "Sign-in failed. Check the code or request a new one." } }, response.status);
  }
  // Better Auth clears its cookie even when the database deletion fails.
  // A bearer session must actually be gone before the desktop drops its key.
  if (path === "/auth/sign-out" && await auth(env).api.getSession({ headers: request.headers })) {
    await response.body?.cancel();
    throw new ApiError(503, "sign_out_failed", "The session could not be revoked. Please try signing out again.");
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  await rateLimit(env, `ip:${await privateHash(env.AUTH_SECRET, ip)}`, 120, 60_000);
  if (url.pathname.startsWith("/auth/")) return authRequest(request, env, url.pathname);
  if (url.pathname === "/operator" && request.method === "POST") return admin(request, env, await readJson(request, 8192));
  const memberId = await authenticate(request, env);
  await rateLimit(env, `member:${memberId}`, 120, 60_000);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/account") return account(env, memberId);
  if (route === "POST /v1/invites/redeem") return redeem(env, memberId, await readJson(request, 4096));
  if (route === "PUT /v1/consent") return consent(env, memberId, await readJson(request, 4096));
  if (route === "POST /v1/completions") return complete(env, memberId, await readJson(request), ctx);
  if (route === "DELETE /v1/account") {
    await deleteAccount(env, memberId);
    return json({ deletion: "pending" }, 202);
  }
  const turn = /^\/v1\/turns\/([a-f0-9-]{36})\/(events|feedback|capture)$/.exec(url.pathname);
  if (turn) {
    const id = z.uuid().parse(turn[1]);
    if (request.method === "POST" && turn[2] === "events") return json({ saved: await event(env, memberId, id, await readJson(request)) });
    if (request.method === "POST" && turn[2] === "feedback") return json({ saved: await feedback(env, memberId, id, await readJson(request, MAX_FEEDBACK_BODY)) });
    if (request.method === "DELETE" && turn[2] === "capture") {
      await deleteTurn(env, memberId, id);
      return json({ deletion: "pending" }, 202);
    }
  }
  throw new ApiError(404, "not_found", "Not found.");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof z.ZodError) return json({ error: { code: "invalid_request", message: "The request has invalid fields." } }, 400);
      console.error(JSON.stringify({ event: "request_failed" }));
      return json({ error: { code: "service_unavailable", message: "Mixing Pal is temporarily unavailable. Please try again later." } }, 503);
    }
  },
  async scheduled(_event, env): Promise<void> {
    await maintain(env);
  },
} satisfies ExportedHandler<Env>;
