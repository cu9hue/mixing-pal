import { deleteReport, deleteReportsFor } from "./reports";
import { z } from "zod";
import { ApiError, CAPTURE_VERSION, DAY, Env, MAX_BODY, privateHash } from "./env";

export interface Turn {
  id: string;
  member_id: string;
  capture: number;
  consent_epoch: number;
  created_at: number;
  deleted_at: number | null;
  status: string;
  incomplete: number;
}

export async function ownedTurn(env: Env, id: string, memberId: string): Promise<Turn> {
  const turn = await env.DB.prepare("SELECT * FROM turns WHERE id = ? AND member_id = ?")
    .bind(id, memberId).first<Turn>();
  if (!turn) throw new ApiError(404, "turn_not_found", "This advice turn was not found.");
  return turn;
}

export async function incomplete(env: Env, turnId: string): Promise<void> {
  await env.DB.prepare("UPDATE turns SET incomplete = 1 WHERE id = ?").bind(turnId).run();
}

export async function saveCapture(env: Env, turn: Turn, id: string, payload: unknown, kind: "trace" | "feedback" = "trace"): Promise<boolean> {
  const raw = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_BODY) {
    await incomplete(env, turn.id);
    return false;
  }
  const bodyHash = await privateHash(env.AUTH_SECRET, raw);
  const key = `captures/${turn.member_id}/${turn.id}/${id}.json`;
  const now = Date.now();
  const prior = await env.DB.prepare("SELECT body_hash, state, turn_id FROM captures WHERE id = ?")
    .bind(id).first<{ body_hash: string; state: string; turn_id: string }>();
  if (prior) {
    if (prior.turn_id !== turn.id || prior.body_hash !== bodyHash) {
      throw new ApiError(409, "event_conflict", "This event identifier has already been used.");
    }
    if (prior.state === "writing") throw new ApiError(409, "event_pending", "This event is still being saved.");
    return prior.state === "ready";
  }
  try {
    await env.DB.prepare(`INSERT INTO captures(id, turn_id, object_key, bytes, body_hash, kind, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'writing', ?, ?)`).bind(id, turn.id, key, bytes, bodyHash, kind, now, now).run();
  } catch (error) {
    if (String(error).includes("capture_disabled")) return false;
    if (String(error).includes("capture_limit")) {
      await incomplete(env, turn.id);
      return false;
    }
    throw error;
  }
  try {
    await env.CAPTURE.put(key, raw, { httpMetadata: { contentType: "application/json" } });
    const saved = await env.DB.prepare(`UPDATE captures SET state = 'ready', updated_at = ? WHERE id = ?
      AND state = 'writing' AND EXISTS (SELECT 1 FROM turns t JOIN members m ON m.id = t.member_id
        WHERE t.id = ? AND t.capture = 1 AND m.capture = 1 AND t.consent_epoch = m.consent_epoch
        AND EXISTS (SELECT 1 FROM consents c WHERE c.member_id = m.id AND c.version = ? AND c.enabled = 1
          AND c.id = (SELECT MAX(id) FROM consents WHERE member_id = m.id))
        AND t.deleted_at IS NULL AND m.deleted_at IS NULL AND t.created_at > ?)`)
      .bind(Date.now(), id, turn.id, CAPTURE_VERSION, Date.now() - 30 * DAY).run();
    if (saved.meta.changes) return true;
    await env.CAPTURE.delete(key);
    await env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE id = ?")
      .bind(Date.now(), id).run();
    return false;
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE id = ?").bind(Date.now(), id),
      env.DB.prepare("UPDATE turns SET incomplete = 1 WHERE id = ?").bind(turn.id),
    ]);
    throw error;
  }
}

export async function optionalCapture(env: Env, turn: Turn, id: string, payload: unknown, ctx: ExecutionContext): Promise<void> {
  if (!turn.capture) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saving = saveCapture(env, turn, id, payload);
  ctx.waitUntil(saving.catch(() => {}));
  try {
    await Promise.race([saving, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Capture deadline")), 2000);
    })]);
  } catch {
    console.error(JSON.stringify({ event: "capture_failed", turn_id: turn.id }));
    // Cleanup must not extend the optional capture deadline.
    ctx.waitUntil(incomplete(env, turn.id).catch(() => {}));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const eventSchema = z.object({ id: z.uuid(), kind: z.enum(["tool", "terminal", "incomplete"]),
  at: z.number().int().nonnegative(), data: z.unknown() });

export async function event(env: Env, memberId: string, turnId: string, input: unknown): Promise<boolean> {
  const data = eventSchema.parse(input);
  const turn = await ownedTurn(env, turnId, memberId);
  if (data.kind === "incomplete") await incomplete(env, turnId);
  if (data.kind === "terminal") {
    const terminal = z.object({ status: z.enum(["complete", "failed", "exhausted", "interrupted"]), incomplete: z.boolean().optional() }).parse(data.data);
    if (terminal.incomplete) await incomplete(env, turnId);
    await env.DB.prepare("UPDATE turns SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(terminal.status, Date.now(), turnId).run();
  }
  return saveCapture(env, turn, data.id, { source: "app", ...data });
}

export async function feedback(env: Env, memberId: string, turnId: string, input: unknown): Promise<boolean> {
  const data = z.object({ id: z.uuid(), outcome: z.enum(["kept", "undone", "tried", "not_tried"]),
    heard: z.string().max(4000) }).parse(input);
  const turn = await ownedTurn(env, turnId, memberId);
  if (!turn.capture || turn.deleted_at !== null || turn.created_at <= Date.now() - 30 * DAY) return false;
  const consent = await env.DB.prepare(`SELECT capture, consent_epoch,
    (SELECT version FROM consents WHERE member_id = members.id ORDER BY id DESC LIMIT 1) AS version,
    (SELECT enabled FROM consents WHERE member_id = members.id ORDER BY id DESC LIMIT 1) AS enabled
    FROM members WHERE id = ? AND deleted_at IS NULL`)
    .bind(memberId).first<{ capture: number; consent_epoch: number; version: string | null; enabled: number | null }>();
  if (consent?.capture !== 1 || consent.consent_epoch !== turn.consent_epoch ||
    consent.version !== CAPTURE_VERSION || consent.enabled !== 1) return false;
  return saveCapture(env, turn, data.id, { kind: "feedback", source: "producer", outcome: data.outcome, heard: data.heard }, "feedback");
}

export async function deleteTurn(env: Env, memberId: string, turnId: string, journal = true, expire = false): Promise<void> {
  const turn = await ownedTurn(env, turnId, memberId);
  const hasReports = !expire && await env.DB.prepare("SELECT 1 FROM support_reports WHERE user_id = ? AND turn_id = ? AND state IN ('ready', 'writing') LIMIT 1")
    .bind(memberId, turnId).first();
  if (journal && !expire && (turn.deleted_at === null || hasReports)) await recordRestriction(env, { member_id: memberId, turn_id: turnId });
  await env.DB.batch([
    env.DB.prepare("UPDATE turns SET deleted_at = COALESCE(deleted_at, ?), capture = 0 WHERE id = ?").bind(Date.now(), turnId),
    env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE turn_id = ? AND state != 'deleted'")
      .bind(Date.now(), turnId),
  ]);
  if (!expire) await deleteReportsFor(env, memberId, turnId);
}

export async function deleteAccount(env: Env, memberId: string, journal = true): Promise<void> {
  const now = Date.now();
  if (journal) await recordRestriction(env, { member_id: memberId });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invites WHERE email = (SELECT lower(email) FROM "user" WHERE id = ?)').bind(memberId),
    env.DB.prepare("UPDATE members SET revoked = 1, capture = 0, consent_epoch = consent_epoch + 1, deleted_at = ? WHERE id = ?")
      .bind(now, memberId),
    env.DB.prepare("UPDATE turns SET deleted_at = COALESCE(deleted_at, ?), capture = 0 WHERE member_id = ?").bind(now, memberId),
    env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE turn_id IN (SELECT id FROM turns WHERE member_id = ?) AND state != 'deleted'")
      .bind(now, memberId),
    env.DB.prepare('DELETE FROM "session" WHERE userId = ?').bind(memberId),
    env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(memberId, now),
  ]);
  await deleteReportsFor(env, memberId);
}

export async function deleteShared(env: Env, memberId: string, journal = true): Promise<void> {
  const now = Date.now();
  if (journal) await recordRestriction(env, { member_id: memberId, shared: true });
  await env.DB.batch([
    env.DB.prepare("UPDATE turns SET deleted_at = COALESCE(deleted_at, ?), capture = 0 WHERE member_id = ?").bind(now, memberId),
    env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE turn_id IN (SELECT id FROM turns WHERE member_id = ?) AND state != 'deleted'")
      .bind(now, memberId),
  ]);
}

export async function revokeAccess(env: Env, memberId: string, journal = true): Promise<void> {
  if (journal) await recordRestriction(env, { member_id: memberId, revoked: true });
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET revoked = 1 WHERE id = ?").bind(memberId),
    env.DB.prepare('DELETE FROM "session" WHERE userId = ?').bind(memberId),
  ]);
}

async function recordRestriction(env: Env, target: { member_id: string; turn_id?: string; revoked?: true; shared?: true }): Promise<void> {
  // This journal must survive restoring D1 to an earlier point in time.
  await env.CAPTURE.put(`deletions/${Date.now()}-${crypto.randomUUID()}.json`,
    JSON.stringify({ ...target, requested_at: Date.now() }), { httpMetadata: { contentType: "application/json" } });
}

export async function replayDeletions(env: Env, cursor?: string): Promise<string | null> {
  // A restored snapshot also loses later charges, not only deletions.
  await env.DB.batch([
    env.DB.prepare("UPDATE budget SET paused = 1, recovery_required = 1"),
    env.DB.prepare("UPDATE members SET recovery_required = 1, capture = 0, consent_epoch = consent_epoch + 1"),
    env.DB.prepare("DELETE FROM invites WHERE redeemed_by IS NULL"),
  ]);
  const page = await env.CAPTURE.list({ prefix: "deletions/", limit: 100, cursor });
  for (const object of page.objects) {
    const saved = await env.CAPTURE.get(object.key);
    if (!saved) continue;
    const entry = z.object({ member_id: z.string(), turn_id: z.uuid().optional(), report_id: z.uuid().optional(), revoked: z.literal(true).optional(), shared: z.literal(true).optional(), requested_at: z.number() }).parse(await saved.json());
    if (entry.report_id) await deleteReport(env, entry.member_id, entry.report_id, false);
    else if (entry.revoked) await revokeAccess(env, entry.member_id, false);
    else if (entry.turn_id) {
      const exists = await env.DB.prepare("SELECT id FROM turns WHERE id = ? AND member_id = ?").bind(entry.turn_id, entry.member_id).first();
      if (exists) await deleteTurn(env, entry.member_id, entry.turn_id, false);
    } else if (entry.shared) await deleteShared(env, entry.member_id, false);
    else await deleteAccount(env, entry.member_id, false);
  }
  return page.truncated ? page.cursor : null;
}
