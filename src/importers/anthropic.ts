/**
 * Anthropic Admin API: GET /v1/organizations/usage_report/messages
 *
 * Input is the raw JSON response (one page, or several concatenated into an
 * array). Each bucket holds `results`, one per group_by combination. We take
 * the model from the result (so the report must be grouped by `model`) and the
 * principal from `api_key_id`, falling back to `account_id`.
 *
 * Token mapping:
 *   inputTokens  = uncached_input_tokens + cache_creation.* (cache writes are
 *                  billed at or above the input rate, so counting them as
 *                  input is the conservative choice; the pricing file can
 *                  carry a separate cached rate for cache reads only)
 *   cachedTokens = cache_read_input_tokens
 *   outputTokens = output_tokens
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { UsageRecord } from "../types.js";

const Result = z.object({
  account_id: z.string().nullable().optional(),
  api_key_id: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
  service_account_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  context_window: z.string().nullable().optional(),
  speed: z.string().nullable().optional(),
  inference_geo: z.string().nullable().optional(),
  uncached_input_tokens: z.number().int().nonnegative().default(0),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cache_creation: z
    .object({
      ephemeral_1h_input_tokens: z.number().int().nonnegative().default(0),
      ephemeral_5m_input_tokens: z.number().int().nonnegative().default(0),
    })
    .default({}),
  output_tokens: z.number().int().nonnegative().default(0),
});

const Bucket = z.object({
  starting_at: z.string().datetime({ offset: true }),
  ending_at: z.string().datetime({ offset: true }),
  results: z.array(Result),
});

export const AnthropicUsageReport = z.object({
  data: z.array(Bucket),
  has_more: z.boolean().optional(),
  next_page: z.string().nullable().optional(),
});
export type AnthropicUsageReport = z.infer<typeof AnthropicUsageReport>;

export function parseAnthropicUsage(json: unknown): UsageRecord[] {
  const pages = Array.isArray(json) ? json.map((p) => AnthropicUsageReport.parse(p)) : [AnthropicUsageReport.parse(json)];
  const out: UsageRecord[] = [];
  for (const page of pages) {
    for (const bucket of page.data) {
      for (const r of bucket.results) {
        if (!r.model) throw new Error(`Anthropic usage bucket at ${bucket.starting_at} has no model; request the report with group_by[]=model`);
        const principal = r.api_key_id ?? r.account_id ?? r.service_account_id ?? null;
        const inputTokens =
          r.uncached_input_tokens + r.cache_creation.ephemeral_5m_input_tokens + r.cache_creation.ephemeral_1h_input_tokens;
        out.push({
          provider: "anthropic",
          model: r.model,
          externalId: stableId([
            bucket.starting_at,
            bucket.ending_at,
            r.model,
            r.api_key_id,
            r.account_id,
            r.workspace_id,
            r.service_account_id,
            r.service_tier,
            r.context_window,
            r.speed,
            r.inference_geo,
          ]),
          principal,
          inputTokens,
          outputTokens: r.output_tokens,
          cachedTokens: r.cache_read_input_tokens,
          occurredAt: new Date(bucket.starting_at),
        });
      }
    }
  }
  return out;
}

export function stableId(parts: (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}
