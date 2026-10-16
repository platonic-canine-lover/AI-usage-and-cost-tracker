import type pg from "pg";
import type { PricedRecord } from "../pricing.js";
import type { PrincipalMap, Provider } from "../types.js";
import { parseAnthropicUsage } from "./anthropic.js";
import { parseOpenAiUsage } from "./openai.js";

export const parsers: Record<Provider, (json: unknown) => ReturnType<typeof parseAnthropicUsage>> = {
  anthropic: parseAnthropicUsage,
  openai: parseOpenAiUsage,
};

export interface ImportSummary {
  inserted: number;
  updated: number;
  unmappedPrincipals: string[];
}

/**
 * Upsert priced records into usage_events for one team.
 *
 * Idempotent on (provider, external_id): re-importing the same export updates
 * token counts and cost in place rather than double-counting. Runs in one
 * transaction so a bad line leaves nothing behind.
 */
export async function upsertUsage(
  client: pg.Client,
  teamId: string,
  records: PricedRecord[],
  principalMap: PrincipalMap = {},
): Promise<ImportSummary> {
  const unmapped = new Set<string>();
  let inserted = 0;
  let updated = 0;

  await client.query("begin");
  try {
    for (const r of records) {
      const userId = r.principal ? (principalMap[r.principal] ?? null) : null;
      if (r.principal && !userId) unmapped.add(r.principal);

      const res = await client.query<{ inserted: boolean }>(
        `insert into usage_events
           (team_id, user_id, provider, model, external_id, input_tokens, output_tokens, cached_tokens, cost_micro_usd, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (provider, external_id) do update set
           user_id        = excluded.user_id,
           input_tokens   = excluded.input_tokens,
           output_tokens  = excluded.output_tokens,
           cached_tokens  = excluded.cached_tokens,
           cost_micro_usd = excluded.cost_micro_usd,
           imported_at    = now()
         returning (xmax = 0) as inserted`,
        [
          teamId,
          userId,
          r.provider,
          r.model,
          r.externalId,
          r.inputTokens,
          r.outputTokens,
          r.cachedTokens,
          r.costMicroUsd,
          r.occurredAt.toISOString(),
        ],
      );
      if (res.rows[0]?.inserted) inserted++;
      else updated++;
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }

  return { inserted, updated, unmappedPrincipals: [...unmapped].sort() };
}
