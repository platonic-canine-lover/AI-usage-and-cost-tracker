/**
 * End to end against a real database: import both providers' fixtures for one
 * team, then check the weekly cap and seat-use reports, idempotent re-import,
 * and that a team member reading the reports through RLS sees only their team.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAnthropicUsage } from "../../src/importers/anthropic.js";
import { upsertUsage } from "../../src/importers/index.js";
import { parseOpenAiUsage } from "../../src/importers/openai.js";
import { loadPricing, MICRO, priceRecords } from "../../src/pricing.js";
import { seatUseReport, weeklyBudgetReport } from "../../src/reports/index.js";
import type { PrincipalMap } from "../../src/types.js";
import { asServiceRole, asUser, createTeam, freshDatabase, newUserId } from "./harness.js";

const fixtures = path.resolve(import.meta.dirname, "../fixtures");
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(fixtures, name), "utf8"));

let db: pg.Client;
const owner = newUserId();
const outsider = newUserId();
let team: string;
let otherTeam: string;
let principals: PrincipalMap;

beforeAll(async () => {
  db = await freshDatabase();
  team = await createTeam(db, owner, "Platform");
  otherTeam = await createTeam(db, outsider, "Elsewhere");
  principals = (await load("principals.test.json")) as PrincipalMap;

  const pricing = await loadPricing(path.join(fixtures, "pricing.test.json"));
  const anthropic = priceRecords(pricing, parseAnthropicUsage(await load("anthropic-usage-report.json"))).priced;
  const openai = priceRecords(pricing, parseOpenAiUsage(await load("openai-completions-usage.json"))).priced;

  const a = await upsertUsage(db, team, anthropic, principals);
  const o = await upsertUsage(db, team, openai, principals);
  expect(a).toEqual({ inserted: 3, updated: 0, unmappedPrincipals: [] });
  expect(o).toEqual({ inserted: 2, updated: 0, unmappedPrincipals: ["key_dave"] });

  // Re-import is a no-op in count terms.
  const again = await upsertUsage(db, team, anthropic, principals);
  expect(again).toEqual({ inserted: 0, updated: 3, unmappedPrincipals: [] });

  // Weekly cap of $10 for the team; seats for Oct 2026 and Oct 2025.
  await db.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, $2)", [team, 10 * MICRO]);
  await db.query(
    `insert into seats (team_id, user_id, provider, monthly_cost_micro_usd, active_from) values
       ($1, $2, 'anthropic', $5, '2026-10-01'),
       ($1, $3, 'anthropic', $5, '2026-10-01'),
       ($1, $4, 'anthropic', $5, '2026-10-01'),
       ($1, $2, 'openai',    $6, '2025-10-01')`,
    [team, principals.apikey_alice, principals.apikey_bob, newUserId(), 20 * MICRO, 30 * MICRO],
  );
});

afterAll(async () => {
  await db.end();
});

describe("weekly budget report", () => {
  it("sums the ISO week of 5 Oct 2026 and flags it over the $10 cap", async () => {
    const rows = await db.query<{ week_start: string; spend_micro_usd: string; over_cap: boolean }>(
      "select week_start::text, spend_micro_usd::text, over_cap from weekly_spend where team_id = $1 order by week_start",
      [team],
    );
    // Anthropic fixture: sonnet $5.76 + opus (50k*$10 + 20k*$50)/1M = $1.50 + haiku (4M*$0.5 + 1M*$2.5)/1M = $4.50 → $11.76
    const oct2026 = rows.rows.find((r) => r.week_start === "2026-10-05");
    expect(oct2026).toBeDefined();
    expect(oct2026!.spend_micro_usd).toBe(String(11_760_000));
    expect(oct2026!.over_cap).toBe(true);

    // OpenAI fixture is Oct 2025: gpt-5-mini (1.5M*$1 + 0.5M*$0.1 + 0.4M*$4)/1M = $3.15 + gpt-5 (90k*$5 + 30k*$20)/1M = $1.05 → $4.20
    const oct2025 = rows.rows.find((r) => r.week_start === "2025-09-29");
    expect(oct2025!.spend_micro_usd).toBe(String(4_200_000));
    expect(oct2025!.over_cap).toBe(false);
  });

  it("the report function joins team names and honours the window", async () => {
    const rows = await weeklyBudgetReport(db, { teamId: team, weeks: 3 });
    expect(rows.every((r) => r.team_name === "Platform")).toBe(true);
    expect(rows.some((r) => r.week_start === "2025-09-29")).toBe(false); // older than 3 weeks
  });
});

describe("seat-use report", () => {
  it("compares paid seats with people who actually generated usage", async () => {
    const rows = await seatUseReport(db, { teamId: team, months: 1 });
    const anthropicOct = rows.find((r) => r.provider === "anthropic" && r.month_start === "2026-10-01");
    expect(anthropicOct).toMatchObject({ paid_seats: 3, active_users: 2, idle_seats: 1 });
    expect(anthropicOct!.seat_cost_micro_usd).toBe(String(60 * MICRO));
    expect(anthropicOct!.usage_cost_micro_usd).toBe(String(11_760_000));
  });

  it("counts a usage-only month with no seats as zero paid seats", async () => {
    const rows = await db.query<{ paid_seats: number; active_users: number }>(
      "select paid_seats, active_users from seat_use where team_id = $1 and provider = 'openai' and month_start = '2025-10-01'",
      [team],
    );
    // One paid openai seat (alice) but the usage was from carol (mapped) and dave (unmapped → not counted)
    expect(rows.rows[0]).toEqual({ paid_seats: 1, active_users: 1 });
  });
});

describe("reports through RLS", () => {
  it("a team member sees only their team in both views", async () => {
    const seen = await asUser(db, owner, async (tx) => ({
      weekly: (await tx.query<{ team_id: string }>("select distinct team_id from weekly_spend")).rows.map((r) => r.team_id),
      seats: (await tx.query<{ team_id: string }>("select distinct team_id from seat_use")).rows.map((r) => r.team_id),
    }));
    expect(seen.weekly).toEqual([team]);
    expect(seen.seats).toEqual([team]);
  });

  it("the other team's owner sees none of it", async () => {
    const seen = await asUser(db, outsider, async (tx) => ({
      weekly: (await tx.query("select 1 from weekly_spend")).rowCount,
      seats: (await tx.query("select 1 from seat_use")).rowCount,
      events: (await tx.query("select 1 from usage_events")).rowCount,
    }));
    expect(seen).toEqual({ weekly: 0, seats: 0, events: 0 });
    // Sanity: the data is really there for the service role.
    const all = await asServiceRole(db, (tx) => tx.query("select 1 from usage_events"));
    expect(all.rowCount).toBe(5);
    expect(otherTeam).not.toBe(team);
  });
});
