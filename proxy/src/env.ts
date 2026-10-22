export interface Env {
  DB: D1Database;
  CAPTURE: R2Bucket;
  RELEASES?: R2Bucket;
  DOWNLOADS_ORIGIN?: string;
  API_ORIGIN: string;
  MAIL_FROM: string;
  AUTH_SECRET: string;
  RESEND_KEY: string;
  OPENROUTER_KEY: string;
  ADMIN_TOKEN: string;
  INFERENCE_ENABLED: string;
  REPORT_RECOVERY?: string;
}

export const DAY = 86_400_000;
export const CAPTURE_VERSION = "quality-2026-09-17";
export const MAX_BODY = 1_048_576;
// A 4,000-character report can need six bytes per character when JSON-escaped.
export const MAX_FEEDBACK_BODY = 32 * 1024;
// A reply at the output cap must finish: 12,000 tokens at 50 a second is 240 s.
export const MODEL_TIMEOUT = 270_000;
// The handler answers within RESPONSE_BUDGET, 15 s under the app's 300 s limit.
export const RESPONSE_BUDGET = 285_000;
export const SETTLE_MARGIN = 15_000;
export const MIN_RUNTIME = 30_000;
export const FIRST_DATA_TIMEOUT = 60_000;
export const IDLE_TIMEOUT = 60_000;
export const SETTLE_TIMEOUT = 10_000;
// OpenRouter's generation statistics lag the call.
export const RECONCILE_DELAY = 60_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function readJson(request: Request | Response, max = MAX_BODY): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_request", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new ApiError(413, "context_too_large", "This request is too large. Start a shorter conversation.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_request", "The request must contain valid JSON.");
  }
}

export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}

export async function privateHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}
