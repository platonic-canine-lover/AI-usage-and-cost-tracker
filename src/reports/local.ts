import type pg from "pg";
import { estimateLocal, type AlternativesFile, type LocalEstimate, type MonthlyVolume } from "../alternatives.js";
import { formatUsd } from "../pricing.js";
import type { Provider } from "../types.js";
import { assertUuid, assertWindow } from "./index.js";

type Queryable = Pick<pg.Client, "query">;

/** Monthly token volume per team, provider and model, from imported usage. */
export async function monthlyVolumes(db: Queryable, opts: { teamId?: string; months?: number } = {}): Promise<MonthlyVolume[]> {
  const teamId = opts.teamId ? assertUuid(opts.teamId) : null;
  const months = assertWindow(opts.months ?? 3, "months", 120);
  const res = await db.query<{
    team_id: string;
    team_name: string;
    provider: Provider;
    model: string;
    month_start: string;
    prompt_tokens: string;
    output_tokens: string;
    cost_micro_usd: string;
    days_in_month: number;
  }>(
    `select u.team_id, t.name as team_name, u.provider::text as provider, u.model,
            date_trunc('month', u.occurred_at at time zone 'UTC')::date::text as month_start,
            sum(u.input_tokens + u.cache_write_tokens + u.cache_write_extended_tokens + u.cached_tokens)::text as prompt_tokens,
            sum(u.output_tokens)::text as output_tokens,
            sum(u.cost_micro_usd)::text as cost_micro_usd,
            extract(day from (date_trunc('month', u.occurred_at at time zone 'UTC') + interval '1 month' - interval '1 day'))::int as days_in_month
       from usage_events u
       join teams t on t.id = u.team_id
      where ($1::uuid is null or u.team_id = $1)
        and u.occurred_at >= (date_trunc('month', now() at time zone 'UTC') - make_interval(months => $2))
      group by u.team_id, t.name, u.provider, u.model, date_trunc('month', u.occurred_at at time zone 'UTC')
      order by month_start desc, t.name, u.provider, u.model`,
    [teamId, months],
  );
  return res.rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    provider: r.provider,
    model: r.model,
    monthStart: r.month_start,
    promptTokens: BigInt(r.prompt_tokens),
    outputTokens: BigInt(r.output_tokens),
    cloudCostMicroUsd: BigInt(r.cost_micro_usd),
    daysInMonth: r.days_in_month,
  }));
}

export function localAlternativeReport(volumes: MonthlyVolume[], alt: AlternativesFile): LocalEstimate[] {
  const out: LocalEstimate[] = [];
  for (const v of volumes) {
    for (const model of alt.local_models) {
      for (const machine of alt.machines) {
        out.push(estimateLocal(v, model, machine, alt.cloud_benchmarks));
      }
    }
  }
  return out;
}

const hours = (h: number): string => {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};

export function renderLocal(estimates: LocalEstimate[]): string {
  if (estimates.length === 0) return "No usage in the selected window.";
  const lines: string[] = [];
  for (const e of estimates) {
    const v = e.volume;
    lines.push(
      `${v.monthStart}  ${v.teamName}  ${v.provider}/${v.model}  →  ${e.model.name} on ${e.machine.name}`,
      `  volume      ${v.promptTokens.toLocaleString()} prompt tokens, ${v.outputTokens.toLocaleString()} output tokens`,
      `  cloud cost  ${formatUsd(v.cloudCostMicroUsd)}`,
      `  local time  ${hours(e.wallClockHours)} of ${hours(e.monthHours)} available  (${(e.utilisation * 100).toFixed(0)}% utilisation` +
        `${e.feasible ? "" : ", CANNOT KEEP UP"})  [throughput ${e.throughputBasis}: ${e.machine.prompt_tokens_per_sec.value} prompt tok/s, ${e.machine.generation_tokens_per_sec.value} gen tok/s]`,
      `  local cost  ${formatUsd(e.localCostDedicatedMicroUsd)} dedicated (${formatUsd(e.energyCostMicroUsd)} energy + ${formatUsd(e.hardwareDedicatedMicroUsd)} hardware/month)` +
        `, ${formatUsd(e.localCostProratedMicroUsd)} if shared (hardware prorated by utilisation)`,
      `  memory      ${e.model.file_size_gb.value} GB model in ${e.machine.memory_gb} GB (${e.machine.os_headroom_gb} GB headroom): ${e.fitsInMemory ? "fits" : "DOES NOT FIT"}`,
    );
    if (e.parity.length) {
      lines.push("  benchmarks  (local score / cloud score, both as published; not a probability)");
      for (const p of e.parity) {
        const cloud = p.cloud === null ? "cloud score not supplied" : `${p.cloud} (ratio ${p.ratio})`;
        lines.push(`    ${p.benchmark.padEnd(28)} ${String(p.local).padEnd(8)} vs ${cloud}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
