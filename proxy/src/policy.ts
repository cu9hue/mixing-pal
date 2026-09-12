import { z } from "zod";
import { ApiError, MODEL, readJson } from "./env";

const toolNames = z.enum(["get_track_detail", "get_clips", "get_clip_notes", "get_arrangement",
  "get_arrangement_notes", "get_device_chains", "get_device_params", "get_rack_contents"]);
export const toolCall = z.object({ id: z.string().min(1).max(200), type: z.literal("function"),
  function: z.object({ name: toolNames, arguments: z.string().max(65_536) }) });
const message = z.object({ role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(), tool_calls: z.array(toolCall).max(32).optional(),
  tool_call_id: z.string().max(200).optional() });

export const completionInput = z.object({
  turn_id: z.uuid(), request_id: z.uuid(), round: z.number().int().min(1).max(6),
  app_version: z.string().regex(/^\d+\.\d+\.\d+$/).max(32), wire_version: z.number().int().min(1).max(10000),
  body: z.object({ messages: z.array(message).min(1).max(512),
    tools: z.array(z.object({ type: z.literal("function"), function: z.object({
      name: toolNames, description: z.string().max(8000), parameters: z.record(z.string(), z.unknown()),
    }) })).min(1).max(8),
  }),
});
export type CompletionInput = z.infer<typeof completionInput>;

export const POLICY_VERSION = "m3-2026-09-12";
export const MAX_CONTEXT = 1_048_576;
export const MAX_OUTPUT = 4096;
export const MAX_PROMPT_PRICE = 0.3;
export const MAX_COMPLETION_PRICE = 1.2;
// Reserve the whole context at the admitted route's ceiling. Character-count
// estimates cannot bound an unknown tokenizer or its message/tool overhead.
export const RESERVATION = Math.ceil(MAX_CONTEXT * MAX_PROMPT_PRICE + MAX_OUTPUT * MAX_COMPLETION_PRICE);
const APPROVED_ROUTES = ["deepinfra/fp8", "venice/fp8", "together", "parasail/fp8", "novita/fp8", "minimax/fp8"];
let verified: { until: number; routes: string[] } | undefined;

export async function routes(): Promise<string[]> {
  if (verified && verified.until > Date.now()) return verified.routes;
  const response = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`,
    { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new ApiError(503, "policy_unavailable", "Model access is temporarily unavailable.");
  const catalog = z.object({ data: z.object({ endpoints: z.array(z.object({
    tag: z.string(), context_length: z.number().positive(), status: z.number(),
    pricing: z.record(z.string(), z.union([z.string(), z.number()])),
  })) }) }).parse(await readJson(response));
  const allowed = catalog.data.endpoints.filter((e) => APPROVED_ROUTES.includes(e.tag)
    && e.status === 0 && e.context_length <= MAX_CONTEXT
    && Number(e.pricing.prompt) <= MAX_PROMPT_PRICE / 1_000_000
    && Number(e.pricing.completion) <= MAX_COMPLETION_PRICE / 1_000_000
    && Object.entries(e.pricing).every(([key, value]) =>
      ["prompt", "completion", "discount"].includes(key)
      || (key === "input_cache_read" && Number(value) <= MAX_PROMPT_PRICE / 1_000_000)
      || Number(value) === 0)).map((e) => e.tag);
  if (allowed.length === 0) throw new ApiError(503, "policy_unavailable", "The model is unavailable within the pilot's limits.");
  verified = { until: Date.now() + 5 * 60_000, routes: allowed };
  return allowed;
}

export function providerBody(input: CompletionInput, only: string[]) {
  return { model: MODEL, messages: input.body.messages, tools: input.body.tools,
    tool_choice: "auto", max_tokens: MAX_OUTPUT, stream: false, reasoning: { enabled: false },
    provider: { only, require_parameters: true, data_collection: "deny", zdr: true,
      max_price: { prompt: MAX_PROMPT_PRICE, completion: MAX_COMPLETION_PRICE, request: 0 } } };
}

const tokenDetails = z.object({ reasoning_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(), cache_write_tokens: z.number().int().nonnegative().optional() });
export const usageSchema = z.object({ cost: z.number().finite().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: tokenDetails.optional(), completion_tokens_details: tokenDetails.optional() });
export const responseSchema = z.object({ id: z.string().max(200).optional(),
  model: z.string().max(200).optional(), provider: z.string().max(200).optional(),
  usage: z.unknown().optional(),
  choices: z.array(z.object({ finish_reason: z.string().max(100).nullable().optional(),
    message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(toolCall).max(32).optional() }) })).min(1).max(1),
});
