import { z } from "zod";
import { ApiError, DAY, Env, MAX_BODY, privateHash } from "./env";

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
  const key = `${turn.member_id}/${turn.id}/${id}.json`;
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
        WHERE t.id = ? AND (? = 'feedback' OR (t.capture = 1 AND m.capture = 1 AND t.consent_epoch = m.consent_epoch))
        AND t.deleted_at IS NULL AND m.deleted_at IS NULL AND t.created_at > ?)`)
      .bind(Date.now(), id, turn.id, kind, Date.now() - 30 * DAY).run();
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

export async function optionalCapture(env: Env, turn: Turn, id: string, payload: unknown): Promise<void> {
  if (!turn.capture) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([saveCapture(env, turn, id, payload), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Capture deadline")), 2000);
    })]);
  } catch {
    console.error(JSON.stringify({ event: "capture_failed", turn_id: turn.id }));
    await incomplete(env, turn.id).catch(() => {});
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
    heard: z.string().max(4000), share: z.literal(true) }).parse(input);
  const turn = await ownedTurn(env, turnId, memberId);
  // Feedback sharing is a per-submission action. It must not turn future
  // capture on, nor reopen content that the producer has already deleted.
  if (turn.deleted_at !== null || turn.created_at <= Date.now() - 30 * DAY) return false;
  return saveCapture(env, turn, data.id, { kind: "feedback", source: "producer", outcome: data.outcome, heard: data.heard }, "feedback");
}

export async function deleteTurn(env: Env, memberId: string, turnId: string, journal = true): Promise<void> {
  await ownedTurn(env, turnId, memberId);
  if (journal) await recordDeletion(env, { member_id: memberId, turn_id: turnId });
  await env.DB.batch([
    env.DB.prepare("UPDATE turns SET deleted_at = COALESCE(deleted_at, ?), capture = 0 WHERE id = ?").bind(Date.now(), turnId),
    env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE turn_id = ? AND state != 'deleted'")
      .bind(Date.now(), turnId),
  ]);
}

export async function deleteAccount(env: Env, memberId: string, journal = true): Promise<void> {
  const now = Date.now();
  if (journal) await recordDeletion(env, { member_id: memberId });
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET revoked = 1, capture = 0, consent_epoch = consent_epoch + 1, deleted_at = ? WHERE id = ?")
      .bind(now, memberId),
    env.DB.prepare("UPDATE turns SET deleted_at = COALESCE(deleted_at, ?), capture = 0 WHERE member_id = ?").bind(now, memberId),
    env.DB.prepare("UPDATE captures SET state = 'deleting', updated_at = ? WHERE turn_id IN (SELECT id FROM turns WHERE member_id = ?) AND state != 'deleted'")
      .bind(now, memberId),
    env.DB.prepare('DELETE FROM "session" WHERE userId = ?').bind(memberId),
    env.DB.prepare("INSERT INTO deletion_jobs(member_id, requested_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(memberId, now),
  ]);
}

async function recordDeletion(env: Env, target: { member_id: string; turn_id?: string }): Promise<void> {
  // This journal must survive restoring D1 to an earlier point in time.
  await env.CAPTURE.put(`deletions/${Date.now()}-${crypto.randomUUID()}.json`,
    JSON.stringify({ ...target, requested_at: Date.now() }), { httpMetadata: { contentType: "application/json" } });
}

export async function replayDeletions(env: Env, cursor?: string): Promise<string | null> {
  await env.DB.prepare("UPDATE budget SET paused = 1").run();
  const page = await env.CAPTURE.list({ prefix: "deletions/", limit: 100, cursor });
  for (const object of page.objects) {
    const saved = await env.CAPTURE.get(object.key);
    if (!saved) continue;
    const entry = z.object({ member_id: z.string(), turn_id: z.uuid().optional(), requested_at: z.number() }).parse(await saved.json());
    if (entry.turn_id) {
      const exists = await env.DB.prepare("SELECT id FROM turns WHERE id = ? AND member_id = ?").bind(entry.turn_id, entry.member_id).first();
      if (exists) await deleteTurn(env, entry.member_id, entry.turn_id, false);
    } else await deleteAccount(env, entry.member_id, false);
  }
  return page.truncated ? page.cursor : null;
}
