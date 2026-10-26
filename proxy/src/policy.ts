import { z } from "zod";
import { ApiError, readJson } from "./env";

export const toolNames = z.enum(["get_track_detail", "get_clips", "get_clip_notes", "get_arrangement",
  "get_arrangement_notes", "get_device_chains", "get_mixer", "get_device_params", "get_rack_contents", "get_sample"]);
export const toolCall = z.object({ id: z.string().min(1).max(200), type: z.literal("function"),
  function: z.object({ name: toolNames, arguments: z.string().max(65_536) }) });
const message = z.object({ role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(), tool_calls: z.array(toolCall).max(32).optional(),
  tool_call_id: z.string().max(200).optional() });

export const completionInput = z.object({
  turn_id: z.uuid(), request_id: z.uuid(), round: z.number().int().min(1).max(6),
  capture_epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
  app_version: z.string().regex(/^\d+\.\d+\.\d+$/).max(32), wire_version: z.number().int().min(1).max(10000),
  body: z.object({ messages: z.array(message).min(1).max(512),
    tools: z.array(z.object({ type: z.literal("function"), function: z.object({
      name: toolNames, description: z.string().max(8000), parameters: z.record(z.string(), z.unknown()),
    }) })).min(1).max(10),
  }),
});
export type CompletionInput = z.infer<typeof completionInput>;

// Reasoning spends from the same cap as the answer. A tighter cap lets a long
// think use it all, and the producer gets a blank card.
export const MAX_OUTPUT = 12_000;

/** One model the pilot serves, with the hosts and prices it may run at. */
export interface ModelPolicy {
  version: string;
  model: string;
  // Zero-retention hosts at the precisions the model was evaluated on.
  routes: string[];
  maxContext: number;
  // Dollars per million tokens, for every price tier a host lists.
  maxPromptPrice: number;
  maxCompletionPrice: number;
}

export const K26: ModelPolicy = { version: "k26-2026-10-03", model: "moonshotai/kimi-k2.6",
  // fp4 and undisclosed quantizations are left out.
  routes: ["inceptron/int4", "crusoe/bf16", "parasail/int4", "venice/int4", "siliconflow/fp8", "moonshotai/int4"],
  maxContext: 262_144, maxPromptPrice: 1.0, maxCompletionPrice: 4.0 };

export const LUNA: ModelPolicy = { version: "luna-2026-10-22", model: "openai/gpt-6-luna",
  // Only Azure serves Luna with zero retention; OpenAI's own endpoint keeps data.
  routes: ["azure", "azure/us", "azure/eu"],
  // The regional hosts list long-prompt cache writes at 0.275, 10% over the
  // global host. Below that cap, a global outage leaves Luna with no host.
  maxContext: 1_050_000, maxPromptPrice: 0.275, maxCompletionPrice: 1.0 };

// 0.2.11 is the first app to let optional tool arguments be null. Luna sends
// every argument, so with an older app's schema its reads fail.
const LUNA_FROM = [0, 2, 11];

export function policyFor(appVersion: string): ModelPolicy {
  const version = appVersion.split(".").map(Number);
  const differs = version.findIndex((n, i) => n !== LUNA_FROM[i]);
  return differs === -1 || version[differs] > LUNA_FROM[differs] ? LUNA : K26;
}

// Reserve the whole context at the admitted route's ceiling. Character-count
// estimates cannot bound an unknown tokenizer or its message/tool overhead.
export const worstCase = (p: ModelPolicy) => Math.ceil(p.maxContext * p.maxPromptPrice + MAX_OUTPUT * p.maxCompletionPrice);
// One reservation covers every model, so allowances never depend on which one answers.
export const RESERVATION = Math.max(worstCase(K26), worstCase(LUNA));

/** Every price a host lists, in every tier, is within the policy's ceilings. */
function withinPrice(pricing: Record<string, unknown>, p: ModelPolicy): boolean {
  const under = (value: unknown, cap: number) => Number(value) <= cap / 1_000_000;
  return Object.entries(pricing).every(([key, value]) => {
    if (key === "discount" || key === "min_prompt_tokens") return true;
    // Charged only when a request asks for web search, and providerBody never does.
    if (key === "web_search") return true;
    if (key === "completion") return under(value, p.maxCompletionPrice);
    if (["prompt", "input_cache_read", "input_cache_write"].includes(key)) return under(value, p.maxPromptPrice);
    if (key === "overrides") return Array.isArray(value)
      && value.every((tier) => typeof tier === "object" && tier !== null && withinPrice(tier as Record<string, unknown>, p));
    return Number(value) === 0;
  });
}

const verified = new Map<string, { until: number; routes: string[] }>();

export async function routes(p: ModelPolicy): Promise<string[]> {
  const cached = verified.get(p.model);
  if (cached && cached.until > Date.now()) return cached.routes;
  const response = await fetch(`https://openrouter.ai/api/v1/models/${p.model}/endpoints`,
    { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new ApiError(503, "policy_unavailable", "Model access is temporarily unavailable.");
  const catalog = z.object({ data: z.object({ endpoints: z.array(z.object({
    tag: z.string(), context_length: z.number().positive(), status: z.number(),
    pricing: z.record(z.string(), z.unknown()),
  })) }) }).parse(await readJson(response));
  const allowed = catalog.data.endpoints.filter((e) => p.routes.includes(e.tag)
    && e.status === 0 && e.context_length <= p.maxContext
    && e.pricing.prompt !== undefined && e.pricing.completion !== undefined
    && withinPrice(e.pricing, p)).map((e) => e.tag);
  if (allowed.length === 0) throw new ApiError(503, "policy_unavailable", "The model is unavailable within the pilot's limits.");
  verified.set(p.model, { until: Date.now() + 5 * 60_000, routes: allowed });
  return allowed;
}

/** The policy that answers this app now, with its eligible hosts. */
export async function serving(appVersion: string): Promise<[ModelPolicy, string[]]> {
  const preferred = policyFor(appVersion);
  // Every app can use K2.6, so any failure to route Luna falls back to it rather than refusing the request.
  if (preferred !== K26) try { return [preferred, await routes(preferred)]; } catch {}
  return [K26, await routes(K26)];
}

export function providerBody(input: CompletionInput, p: ModelPolicy, only: string[]) {
  return { model: p.model, messages: input.body.messages, tools: input.body.tools,
    tool_choice: "auto", max_tokens: MAX_OUTPUT, stream: true, reasoning: { effort: "low" },
    // The approved hosts differ up to 10x in speed at the same moment, and by
    // time of day; without a sort OpenRouter favours the cheapest, not the fastest.
    provider: { only, sort: "throughput", require_parameters: true, data_collection: "deny", zdr: true,
      max_price: { prompt: p.maxPromptPrice, completion: p.maxCompletionPrice, request: 0 } } };
}

const tokenDetails = z.object({ reasoning_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(), cache_write_tokens: z.number().int().nonnegative().optional() });
export const usageSchema = z.object({ cost: z.number().finite().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: tokenDetails.optional(), completion_tokens_details: tokenDetails.optional() });
