import { z } from "zod";
import { ownedTurn } from "./capture";
import { ApiError, CAPTURE_VERSION, DAY, Env, json } from "./env";
import { toolCall } from "./policy";

const modelEvent = z.object({ kind: z.literal("model"), request_id: z.string(), round: z.number(),
  response: z.object({ choices: z.array(z.object({ message: z.object({ tool_calls: z.array(toolCall).optional() }) })) }) });
const toolEvent = z.object({ kind: z.literal("tool"), data: z.object({ round: z.number(), tool_call_id: z.string(),
  name: z.string(), arguments: z.string(), result: z.unknown() }) });
const terminalEvent = z.object({ kind: z.literal("terminal"), data: z.object({ status: z.literal("complete"), incomplete: z.boolean().optional() }) });

export async function exportTurn(env: Env, memberId: string, turnId: string): Promise<Response> {
  const turn = await ownedTurn(env, turnId, memberId);
  if (turn.deleted_at !== null || turn.created_at <= Date.now() - 30 * DAY) {
    throw new ApiError(410, "capture_deleted", "This capture has expired or was deleted.");
  }
  const [rows, requests] = await Promise.all([
    env.DB.prepare("SELECT object_key, state FROM captures WHERE turn_id = ? ORDER BY created_at")
      .bind(turn.id).all<{ object_key: string; state: string }>(),
    env.DB.prepare(`SELECT id, round, status, model, provider, generation_id, usage, finish_reason, duration_ms,
      prompt_hash, tool_hash, policy_version, error_code, provisional FROM requests WHERE turn_id = ? ORDER BY round`)
      .bind(turn.id).all<{ id: string; round: number; status: string }>(),
  ]);
  const events: unknown[] = [];
  let complete = Boolean(turn.capture) && !turn.incomplete && turn.status === "complete";
  for (const row of rows.results) {
    if (row.state !== "ready") { complete = false; continue; }
    const object = await env.CAPTURE.get(row.object_key);
    if (object) events.push(await object.json());
    else complete = false;
  }
  const models = events.flatMap((event) => { const parsed = modelEvent.safeParse(event); return parsed.success ? [parsed.data] : []; });
  const tools = events.flatMap((event) => { const parsed = toolEvent.safeParse(event); return parsed.success ? [parsed.data.data] : []; });
  complete &&= requests.results.length > 0 && requests.results.every((request) => request.status === "settled"
    && models.filter((event) => event.request_id === request.id && event.round === request.round).length === 1);
  complete &&= models.every((event) => event.response.choices.length === 1 && (event.response.choices[0].message.tool_calls ?? []).every((call) =>
    tools.some((tool) => tool.round === event.round && tool.tool_call_id === call.id && tool.name === call.function.name
      && tool.arguments === call.function.arguments && "result" in tool)));
  complete &&= events.some((event) => { const parsed = terminalEvent.safeParse(event); return parsed.success && !parsed.data.data.incomplete; });
  // Check again after reading objects; deletion can race a long export.
  const current = await ownedTurn(env, turn.id, memberId);
  if (current.deleted_at !== null) throw new ApiError(410, "capture_deleted", "This capture was deleted.");
  complete &&= !current.incomplete;
  return json({ format: "mixing-pal-turn-v1", turn: current, complete, consent_version: CAPTURE_VERSION,
    expires_at: turn.created_at + 30 * DAY, training_allowed: false, requests: requests.results, events });
}
