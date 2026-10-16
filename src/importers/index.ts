import type pg from "pg";
import type { PricedRecord } from "../pricing.js";
import type { PrincipalMap, Provider, UsageRecord } from "../types.js";
import { parseAnthropicUsage } from "./anthropic.js";
import { parseOpenAiUsage } from "./openai.js";

export type ParseOptions = { allowPartial?: boolean };

export const parsers: Record<Provider, (json: unknown, opts?: ParseOptions) => UsageRecord[]> = {
  anthropic: parseAnthropicUsage,
  openai: parseOpenAiUsage,
};

export interface ImportSummary {
  inserted: number;
  updated: number;
  unmappedPrincipals: string[];
}

/** A provider record belongs to exactly one team. Importing it into a second team is an error, never a silent update. */
export class CrossTeamConflictError extends Error {
  constructor(
    public readonly provider: Provider,
    public readonly conflicts: { externalId: string; ownerTeamId: string }[],
  ) {
    const owners = [...new Set(conflicts.map((c) => c.ownerTeamId))];
    super(
      `${conflicts.length} ${provider} record(s) already belong to another team (${owners.join(", ")}). ` +
        `A provider usage record is owned by one team; nothing was imported.`,
    );
  }
}

export class UnknownTeamError extends Error {
  constructor(public readonly teamId: string) {
    super(`Team ${teamId} does not exist; nothing was imported.`);
  }
}

/**
 * Upsert priced records into usage_events for one team.
 *
 * Ownership model: a provider usage record (provider, external_id) belongs to
 * exactly one team. Re-importing the same export for the same team updates
 * token counts, cost and attribution in place. Importing it for a different
 * team raises CrossTeamConflictError and rolls back, so a shared organisation
 * export cannot be counted twice or quietly re-homed.
 *
 * Runs in one transaction: a bad line, an unknown team or a conflict leaves
 * nothing behind.
 */
export async function upsertUsage(
  client: pg.Client,
  teamId: string,
  records: PricedRecord[],
  principalMap: PrincipalMap = {},
  opts: { pricingVersion?: string } = {},
): Promise<ImportSummary> {
  const unmapped = new Set<string>();
  let inserted = 0;
  let updated = 0;

  await client.query("begin");
  try {
    const team = await client.query("select 1 from teams where id = $1", [teamId]);
    if (team.rowCount === 0) throw new UnknownTeamError(teamId);

    if (records.length > 0) {
      const provider = records[0]!.provider;
      const ids = records.map((r) => r.externalId);
      const foreign = await client.query<{ external_id: string; team_id: string }>(
        `select external_id, team_id from usage_events
          where provider = $1 and external_id = any($2::text[]) and team_id <> $3`,
        [provider, ids, teamId],
      );
      if (foreign.rowCount) {
        throw new CrossTeamConflictError(
          provider,
          foreign.rows.map((r) => ({ externalId: r.external_id, ownerTeamId: r.team_id })),
        );
      }
    }

    for (const r of records) {
      const userId = r.principal ? (principalMap[r.principal] ?? null) : null;
      if (r.principal && !userId) unmapped.add(r.principal);

      // The WHERE on the conflict branch is the row-level guard behind the
      // check above: even under a concurrent import, a row owned by another
      // team is never updated. Zero rows back means a conflict slipped past.
      const res = await client.query<{ inserted: boolean }>(
        `insert into usage_events
           (team_id, user_id, provider, model, external_id, input_tokens, output_tokens, cached_tokens,
            cost_micro_usd, pricing_version, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (provider, external_id) do update set
           user_id         = excluded.user_id,
           input_tokens    = excluded.input_tokens,
           output_tokens   = excluded.output_tokens,
           cached_tokens   = excluded.cached_tokens,
           cost_micro_usd  = excluded.cost_micro_usd,
           pricing_version = excluded.pricing_version,
           imported_at     = now()
         where usage_events.team_id = excluded.team_id
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
          r.costMicroUsd.toString(),
          opts.pricingVersion ?? null,
          r.occurredAt.toISOString(),
        ],
      );
      if (res.rowCount === 0) {
        throw new CrossTeamConflictError(r.provider, [{ externalId: r.externalId, ownerTeamId: "(concurrent import)" }]);
      }
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
