/**
 * OpenAI Usage API: GET /v1/organization/usage/completions
 *
 * Input is the raw JSON response (one page, or an array of pages). Buckets
 * use unix-second `start_time`/`end_time`. The report must be grouped by
 * `model`; the principal is `api_key_id`, falling back to `user_id`, then
 * `project_id`.
 *
 * Token mapping. OpenAI's `input_tokens` is the total and already includes
 * cached and cache-write tokens, so the uncached figure is derived:
 *   uncachedInput      = input_tokens - input_cached_tokens - cache writes
 *   cacheWrite         = input_cache_write_tokens
 *   cacheWriteExtended = input_cache_write_12h_tokens
 *   cacheRead          = input_cached_tokens
 *   output             = output_tokens
 * Audio and image token sub-totals are not priced separately here; they are
 * part of input_tokens / output_tokens and priced at the text rate. If a
 * model bills them differently, give it its own pricing entry or treat the
 * figure as an estimate.
 */
import { z } from "zod";
import type { UsageRecord } from "../types.js";
import { assertComplete, stableId } from "./anthropic.js";

const Result = z.object({
  object: z.literal("organization.usage.completions.result").optional(),
  input_tokens: z.number().int().nonnegative().default(0),
  input_cached_tokens: z.number().int().nonnegative().default(0),
  input_cache_write_tokens: z.number().int().nonnegative().default(0),
  input_cache_write_12h_tokens: z.number().int().nonnegative().default(0),
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
        const uncached = r.input_tokens - r.input_cached_tokens - r.input_cache_write_tokens - r.input_cache_write_12h_tokens;
        if (uncached < 0) {
          throw new Error(
            `OpenAI usage bucket at ${bucket.start_time}: cached and cache-write tokens exceed input_tokens for ${r.model}; refusing to guess`,
          );
        }
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
          tokens: {
            uncachedInput: uncached,
            cacheWrite: r.input_cache_write_tokens,
            cacheWriteExtended: r.input_cache_write_12h_tokens,
            cacheRead: r.input_cached_tokens,
            output: r.output_tokens,
          },
          occurredAt: new Date(bucket.start_time * 1000),
        });
      }
    }
  }
  return out;
}
