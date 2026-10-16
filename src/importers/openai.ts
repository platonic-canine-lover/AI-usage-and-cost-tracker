/**
 * OpenAI Usage API: GET /v1/organization/usage/completions
 *
 * Input is the raw JSON response (one page, or an array of pages). Buckets
 * use unix-second `start_time`/`end_time`. The report must be grouped by
 * `model`; the principal is `api_key_id`, falling back to `user_id`, then
 * `project_id`.
 *
 * Token mapping: OpenAI's `input_tokens` already includes cached tokens, so
 *   inputTokens  = input_tokens - input_cached_tokens
 *   cachedTokens = input_cached_tokens
 *   outputTokens = output_tokens
 */
import { z } from "zod";
import type { UsageRecord } from "../types.js";
import { assertComplete, stableId } from "./anthropic.js";

const Result = z.object({
  object: z.literal("organization.usage.completions.result").optional(),
  input_tokens: z.number().int().nonnegative().default(0),
  input_cached_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  num_model_requests: z.number().int().nonnegative().optional(),
  project_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  api_key_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  batch: z.boolean().nullable().optional(),
  service_tier: z.string().nullable().optional(),
});

const Bucket = z.object({
  object: z.literal("bucket").optional(),
  start_time: z.number().int(),
  end_time: z.number().int(),
  results: z.array(Result),
});

export const OpenAiUsagePage = z.object({
  object: z.literal("page").optional(),
  data: z.array(Bucket),
  has_more: z.boolean().optional(),
  next_page: z.string().nullable().optional(),
});
export type OpenAiUsagePage = z.infer<typeof OpenAiUsagePage>;

export function parseOpenAiUsage(json: unknown, opts: { allowPartial?: boolean } = {}): UsageRecord[] {
  const pages = Array.isArray(json) ? json.map((p) => OpenAiUsagePage.parse(p)) : [OpenAiUsagePage.parse(json)];
  assertComplete(pages, opts);
  const out: UsageRecord[] = [];
  for (const page of pages) {
    for (const bucket of page.data) {
      for (const r of bucket.results) {
        if (!r.model) throw new Error(`OpenAI usage bucket at ${bucket.start_time} has no model; request the report with group_by[]=model`);
        const cached = Math.min(r.input_cached_tokens, r.input_tokens);
        out.push({
          provider: "openai",
          model: r.model,
          externalId: stableId([
            String(bucket.start_time),
            String(bucket.end_time),
            r.model,
            r.api_key_id,
            r.user_id,
            r.project_id,
            r.batch == null ? null : String(r.batch),
            r.service_tier,
          ]),
          principal: r.api_key_id ?? r.user_id ?? r.project_id ?? null,
          inputTokens: r.input_tokens - cached,
          outputTokens: r.output_tokens,
          cachedTokens: cached,
          occurredAt: new Date(bucket.start_time * 1000),
        });
      }
    }
  }
  return out;
}
