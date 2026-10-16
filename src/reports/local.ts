import type pg from "pg";
import { estimateLocal, type AlternativesFile, type HumanSide, type LocalEstimate, type MonthlyVolume, type TaskQuality } from "../alternatives.js";
import { formatUsd } from "../pricing.js";
import type { Provider } from "../types.js";
import { assertUuid, assertWindow } from "./index.js";

type Queryable = Pick<pg.Client, "query">;

export interface VolumeOptions {
  teamId?: string;
  /** Number of completed calendar months to include (default 3). */
  months?: number;
  /** Also include the current, incomplete month, labelled month-to-date. Default false. */
  includeCurrent?: boolean;
  /** Clock for tests. */
  now?: Date;
}

/**
 * Monthly token volume per team, provider and model, from imported usage.
 *
 * Completed calendar months only by default, so month-to-date cloud usage is
 * never compared with a full month of local running cost. With
 * `includeCurrent`, the current month is returned too, flagged, with
 * `daysCovered` set to the elapsed days so every per-month figure downstream
 * is scaled to the same window.
 */
export async function monthlyVolumes(db: Queryable, opts: VolumeOptions = {}): Promise<MonthlyVolume[]> {
  const teamId = opts.teamId ? assertUuid(opts.teamId) : null;
  const months = assertWindow(opts.months ?? 3, "months", 120);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
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
    is_current: boolean;
    elapsed_days: number;
  }>(
    `with bounds as (
       select date_trunc('month', $3::timestamptz at time zone 'UTC') as current_month,
              ($3::timestamptz at time zone 'UTC') as now_utc
     )
     select u.team_id, t.name as team_name, u.provider::text as provider, u.model,
            date_trunc('month', u.occurred_at at time zone 'UTC')::date::text as month_start,
            sum(u.input_tokens + u.cache_write_tokens + u.cache_write_extended_tokens + u.cached_tokens)::text as prompt_tokens,
            sum(u.output_tokens)::text as output_tokens,
            sum(u.cost_micro_usd)::text as cost_micro_usd,
            extract(day from (date_trunc('month', u.occurred_at at time zone 'UTC') + interval '1 month' - interval '1 day'))::int as days_in_month,
            date_trunc('month', u.occurred_at at time zone 'UTC') = b.current_month as is_current,
            (extract(day from b.now_utc)::int) as elapsed_days
       from usage_events u
       join teams t on t.id = u.team_id
       cross join bounds b
      where ($1::uuid is null or u.team_id = $1)
        and (u.occurred_at at time zone 'UTC') >= b.current_month - make_interval(months => $2)
        and ($4::boolean or (u.occurred_at at time zone 'UTC') < b.current_month)
      group by u.team_id, t.name, u.provider, u.model, date_trunc('month', u.occurred_at at time zone 'UTC'), b.current_month, b.now_utc
      order by month_start desc, t.name, u.provider, u.model`,
    [teamId, months, nowIso, opts.includeCurrent ?? false],
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
    monthToDate: r.is_current,
    daysCovered: r.is_current ? r.elapsed_days : r.days_in_month,
  }));
}

/** Recorded human effort per (team, provider, model) from the task_quality view. */
export async function taskQuality(db: Queryable, teamId?: string): Promise<Map<string, TaskQuality>> {
  const res = await db.query<{
    team_id: string;
    provider: string;
    model: string;
    attempts: number;
    accepted: number;
    avg_review_minutes: string;
    avg_retries: string;
    acceptance_rate: string;
  }>(
    `select team_id, provider::text as provider, model, attempts, accepted, avg_review_minutes::text, avg_retries::text, acceptance_rate::text
       from task_quality where ($1::uuid is null or team_id = $1)`,
    [teamId ?? null],
  );
  const map = new Map<string, TaskQuality>();
  for (const r of res.rows) {
    map.set(`${r.team_id}|${r.provider}|${r.model}`, {
      attempts: r.attempts,
      accepted: r.accepted,
      avgReviewMinutes: Number(r.avg_review_minutes),
      avgRetries: Number(r.avg_retries),
      acceptanceRate: Number(r.acceptance_rate),
    });
  }
  return map;
}

export function localAlternativeReport(volumes: MonthlyVolume[], alt: AlternativesFile, quality = new Map<string, TaskQuality>()): LocalEstimate[] {
  const out: LocalEstimate[] = [];
  for (const v of volumes) {
    for (const model of alt.local_models) {
      for (const machine of alt.machines) {
        out.push(
          estimateLocal(v, model, machine, alt.cloud_benchmarks, {
            human: alt.human,
            localQuality: quality.get(`${v.teamId}|local|${model.id}`),
            cloudQuality: quality.get(`${v.teamId}|${v.provider}|${v.model}`),
          }),
        );
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

const humanLine = (label: string, side: HumanSide): string => {
  if (side.basis === "none") return `    ${label.padEnd(6)} no task outcomes recorded and no default_review_minutes_per_task set`;
  const acc = side.acceptanceRate === null ? "acceptance unknown" : `${(side.acceptanceRate * 100).toFixed(0)}% accepted`;
  const per = side.reviewCostPerAttemptMicroUsd === null ? "-" : formatUsd(side.reviewCostPerAttemptMicroUsd);
  const perAcc = side.reviewCostPerAcceptedMicroUsd === null ? "-" : formatUsd(side.reviewCostPerAcceptedMicroUsd);
  const retries = side.avgRetries === null ? "" : `, ${side.avgRetries} retries avg`;
  return `    ${label.padEnd(6)} ${side.avgReviewMinutes} min review/attempt → ${per}/attempt, ${perAcc}/accepted result (${acc}${retries}) [${side.basis}${side.basis === "recorded" ? `, ${side.attempts} attempts` : ""}]`;
};

export function renderLocal(estimates: LocalEstimate[]): string {
  if (estimates.length === 0) return "No usage in the selected window (completed months only; pass --include-current for month-to-date).";
  const lines: string[] = [];
  for (const e of estimates) {
    const v = e.volume;
    const window = v.monthToDate ? `${v.monthStart} MONTH-TO-DATE (${v.daysCovered} of ${v.daysInMonth} days; all figures scaled to that window)` : v.monthStart;
    lines.push(
      `${window}  ${v.teamName}  ${v.provider}/${v.model}  →  ${e.model.name} on ${e.machine.name}`,
      `  volume      ${v.promptTokens.toLocaleString()} prompt tokens, ${v.outputTokens.toLocaleString()} output tokens`,
      `  cloud cost  ${formatUsd(v.cloudCostMicroUsd)}`,
      `  local time  ${hours(e.wallClockHours)} of ${hours(e.monthHours)} available  (${(e.utilisation * 100).toFixed(0)}% utilisation` +
        `${e.feasible ? "" : ", CANNOT KEEP UP"})  [throughput ${e.throughputBasis}: ${e.machine.prompt_tokens_per_sec.value} prompt tok/s, ${e.machine.generation_tokens_per_sec.value} gen tok/s]`,
      `  local cost  ${formatUsd(e.localCostDedicatedMicroUsd)} dedicated (${formatUsd(e.energyCostMicroUsd)} energy + ${formatUsd(e.hardwareDedicatedMicroUsd)} hardware)` +
        `, ${formatUsd(e.localCostProratedMicroUsd)} if shared (hardware prorated by utilisation)`,
      `  memory      ${e.memory.verdict}`,
    );
    if (e.human.length) {
      for (const h of e.human) {
        const rate = h.currency === "USD" ? `$${h.hourly}/h` : `${h.currency} ${h.hourly}/h ≈ $${h.hourlyUsd.toFixed(2)}/h [fx ${h.fxBasis}]`;
        lines.push(`  human       ${h.label}: ${rate} (machine time above excludes this)`);
        lines.push(humanLine("local", h.local));
        lines.push(humanLine("cloud", h.cloud));
      }
    } else {
      lines.push("  human       not costed: set human.hourly_usd in the alternatives file to include review time");
    }
    if (e.parity.length) {
      lines.push("  benchmarks  (local score / cloud score, both as published; not a probability)");
      for (const p of e.parity) {
        const cloud = p.cloud === null ? "cloud score not supplied" : `${p.cloud} (ratio ${p.ratio})`;
        lines.push(`    ${p.benchmark.padEnd(38)} ${String(p.local).padEnd(8)} vs ${cloud}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
