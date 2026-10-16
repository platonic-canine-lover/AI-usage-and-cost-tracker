import type pg from "pg";
import { formatUsd } from "../pricing.js";

type Queryable = Pick<pg.Client, "query">;

export interface WeeklyRow {
  team_id: string;
  team_name: string;
  week_start: string;
  spend_micro_usd: string;
  weekly_cap_micro_usd: string | null;
  over_cap: boolean;
  event_count: string;
}

/** Spend per team per ISO week against the weekly cap, most recent weeks first. */
export async function weeklyBudgetReport(db: Queryable, opts: { teamId?: string; weeks?: number } = {}): Promise<WeeklyRow[]> {
  const res = await db.query<WeeklyRow>(
    `select w.team_id, t.name as team_name, w.week_start::text, w.spend_micro_usd::text,
            w.weekly_cap_micro_usd::text, w.over_cap, w.event_count::text
       from weekly_spend w
       join teams t on t.id = w.team_id
      where ($1::uuid is null or w.team_id = $1)
        and w.week_start >= (date_trunc('week', now() at time zone 'UTC') - make_interval(weeks => $2))::date
      order by w.week_start desc, t.name`,
    [opts.teamId ?? null, opts.weeks ?? 8],
  );
  return res.rows;
}

export interface SeatRow {
  team_id: string;
  team_name: string;
  provider: string;
  month_start: string;
  paid_seats: number;
  active_users: number;
  idle_seats: number;
  seat_cost_micro_usd: string;
  usage_cost_micro_usd: string;
}

/** Paid seats vs people who actually used each provider, per month. */
export async function seatUseReport(db: Queryable, opts: { teamId?: string; months?: number } = {}): Promise<SeatRow[]> {
  const res = await db.query<SeatRow>(
    `select s.team_id, t.name as team_name, s.provider::text, s.month_start::text,
            s.paid_seats, s.active_users, s.idle_seats,
            s.seat_cost_micro_usd::text, s.usage_cost_micro_usd::text
       from seat_use s
       join teams t on t.id = s.team_id
      where ($1::uuid is null or s.team_id = $1)
        and s.month_start >= (date_trunc('month', now() at time zone 'UTC') - make_interval(months => $2))::date
      order by s.month_start desc, t.name, s.provider`,
    [opts.teamId ?? null, opts.months ?? 6],
  );
  return res.rows;
}

export function renderWeekly(rows: WeeklyRow[]): string {
  if (rows.length === 0) return "No usage in the selected window.";
  const lines = ["Week        Team                 Spend       Cap         Status"];
  for (const r of rows) {
    const cap = r.weekly_cap_micro_usd ? formatUsd(r.weekly_cap_micro_usd) : "(none)";
    const status = r.weekly_cap_micro_usd ? (r.over_cap ? "OVER CAP" : "ok") : "no cap";
    lines.push(`${r.week_start}  ${pad(r.team_name, 20)} ${pad(formatUsd(r.spend_micro_usd), 11)} ${pad(cap, 11)} ${status}`);
  }
  return lines.join("\n");
}

export function renderSeats(rows: SeatRow[]): string {
  if (rows.length === 0) return "No seats or usage in the selected window.";
  const lines = ["Month       Team                 Provider   Paid  Active  Idle  Seat cost   Usage cost  Usage/active seat"];
  for (const r of rows) {
    const perActive = r.active_users > 0 ? formatUsd(Number(r.usage_cost_micro_usd) / r.active_users) : "-";
    lines.push(
      `${r.month_start}  ${pad(r.team_name, 20)} ${pad(r.provider, 10)} ${pad(String(r.paid_seats), 5)} ${pad(String(r.active_users), 7)} ${pad(String(r.idle_seats), 5)} ${pad(formatUsd(r.seat_cost_micro_usd), 11)} ${pad(formatUsd(r.usage_cost_micro_usd), 11)} ${perActive}`,
    );
  }
  return lines.join("\n");
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
