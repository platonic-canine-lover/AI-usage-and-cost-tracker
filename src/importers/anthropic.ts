/**
 * Anthropic Admin API: GET /v1/organizations/usage_report/messages
 *
 * Input is the raw JSON response (one page, or several concatenated into an
 * array). Each bucket holds `results`, one per group_by combination. We take
 * the model from the result (so the report must be grouped by `model`) and the
 * principal from `api_key_id`, falling back to `account_id`.
 *
 * Token mapping (each category keeps its own rate in the pricing file):
 *   uncachedInput       = uncached_input_tokens
 *   cacheWrite          = cache_creation.ephemeral_5m_input_tokens
 *   cacheWriteExtended  = cache_creation.ephemeral_1h_input_tokens
 *   cacheRead           = cache_read_input_tokens
 *   output              = output_tokens
 *
 * Not covered: server_tool_use (web search requests) is a per-request charge,
 * not a token one, and is not imported. It is listed so nobody assumes it is.
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

export function parseAnthropicUsage(json: unknown, opts: { allowPartial?: boolean } = {}): UsageRecord[] {
  const pages = Array.isArray(json) ? json.map((p) => AnthropicUsageReport.parse(p)) : [AnthropicUsageReport.parse(json)];
  assertComplete(pages, opts);
  const out: UsageRecord[] = [];
  for (const page of pages) {
    for (const bucket of page.data) {
      for (const r of bucket.results) {
        if (!r.model) throw new Error(`Anthropic usage bucket at ${bucket.starting_at} has no model; request the report with group_by[]=model`);
        const principal = r.api_key_id ?? r.account_id ?? r.service_account_id ?? null;
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
          tokens: {
            uncachedInput: r.uncached_input_tokens,
            cacheWrite: r.cache_creation.ephemeral_5m_input_tokens,
            cacheWriteExtended: r.cache_creation.ephemeral_1h_input_tokens,
            cacheRead: r.cache_read_input_tokens,
            output: r.output_tokens,
          },
          occurredAt: new Date(bucket.starting_at),
        });
      }
    }
  }
  return out;
}

export class IncompleteExportError extends Error {
  constructor(detail: string) {
    super(
      `Export is incomplete or its pagination metadata is inconsistent: ${detail}. ` +
        `Fetch every page (follow next_page until has_more is false) and pass them as a JSON array, or pass --allow-partial to import what is here.`,
    );
  }
}

type PageMeta = { has_more?: boolean | undefined; next_page?: string | null | undefined };

/**
 * A usage export is only trustworthy if it is the whole thing, and the pages
 * say so explicitly. Unless `allowPartial`:
 *   - every page must carry `has_more` (a page without it is not a complete
 *     provider response, and we do not guess);
 *   - every non-final page must have has_more=true and a non-null next_page;
 *   - the final page must have has_more=false, and if it carries next_page it
 *     must be null.
 */
export function assertComplete(pages: PageMeta[], opts: { allowPartial?: boolean }) {
  if (opts.allowPartial) return;
  if (pages.length === 0) throw new IncompleteExportError("no pages supplied");
  pages.forEach((p, i) => {
    const n = i + 1;
    const final = i === pages.length - 1;
    if (p.has_more === undefined) throw new IncompleteExportError(`page ${n} has no has_more field`);
    if (final) {
      if (p.has_more) throw new IncompleteExportError(`the last page (${n} of ${pages.length}) has has_more=true`);
      if (p.next_page) throw new IncompleteExportError(`the last page has has_more=false but a next_page cursor`);
    } else {
      if (!p.has_more) throw new IncompleteExportError(`page ${n} is marked as the final page but ${pages.length - n} more follow it`);
      if (!p.next_page) throw new IncompleteExportError(`page ${n} has has_more=true but no next_page cursor`);
    }
  });
}

export function stableId(parts: (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}
