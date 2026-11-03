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
import { CrossTeamConflictError, UnknownTeamError, upsertUsage } from "../../src/importers/index.js";
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

  const a = await upsertUsage(db, team, anthropic, principals, { pricing });
  const o = await upsertUsage(db, team, openai, principals, { pricing });
  expect(a).toEqual({ inserted: 3, updated: 0, unmappedPrincipals: [] });
  expect(o).toEqual({ inserted: 2, updated: 0, unmappedPrincipals: ["key_dave"] });

  // Re-import is a no-op in count terms.
  const again = await upsertUsage(db, team, anthropic, principals, { pricing });
  expect(again).toEqual({ inserted: 0, updated: 3, unmappedPrincipals: [] });

  // Weekly cap of $10 for the team; seats for Oct 2026 and Oct 2025.
  await db.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, $2)", [team, 9 * MICRO]);
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

describe("import ownership and provenance", () => {
  it("refuses to import a record that another team already owns, and rolls back the whole batch", async () => {
    const pricing = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const anthropic = priceRecords(pricing, parseAnthropicUsage(await load("anthropic-usage-report.json"))).priced;
    const before = await db.query("select count(*)::int as n from usage_events");

    await expect(upsertUsage(db, otherTeam, anthropic, principals)).rejects.toThrow(CrossTeamConflictError);

    const after = await db.query("select count(*)::int as n from usage_events");
    expect(after.rows[0]).toEqual(before.rows[0]);
    const owners = await db.query<{ team_id: string }>("select distinct team_id from usage_events where provider = 'anthropic'");
    expect(owners.rows.map((r) => r.team_id)).toEqual([team]);
  });

  it("the row-level guard holds even if the pre-check is bypassed", async () => {
    // Simulate a concurrent import racing past the SELECT: an UPSERT from the other team must affect zero rows.
    const row = await db.query<{ external_id: string }>("select external_id from usage_events where provider = 'anthropic' limit 1");
    const res = await db.query(
      `insert into usage_events (team_id, provider, model, external_id, cost_micro_usd, occurred_at)
       values ($1, 'anthropic', 'x', $2, 1, now())
       on conflict (provider, external_id) do update set cost_micro_usd = excluded.cost_micro_usd
       where usage_events.team_id = excluded.team_id
       returning team_id`,
      [otherTeam, row.rows[0]!.external_id],
    );
    expect(res.rowCount).toBe(0);
  });

  it("refuses an unknown team before touching anything", async () => {
    await expect(upsertUsage(db, newUserId(), [], principals)).rejects.toThrow(UnknownTeamError);
  });

  it("stamps every row with the pricing version that produced its cost", async () => {
    const res = await db.query<{ pricing_version: string; n: string }>(
      "select pricing_version, count(*) as n from usage_events group by pricing_version",
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.pricing_version).toBe("test-v1");
  });

  it("stores the tier and bucket each row was priced on, and a note where the figure is approximate", async () => {
    const haiku = await db.query<{ service_tier: string; context_window: string; pricing_note: string | null; cost_micro_usd: string }>(
      "select service_tier, context_window, pricing_note, cost_micro_usd::text from usage_events where model = 'claude-haiku-5-5'",
    );
    expect(haiku.rows[0]).toMatchObject({ service_tier: "batch", context_window: "0-200k", cost_micro_usd: String(2_250_000) });
    expect(haiku.rows[0]!.pricing_note).toMatch(/straddles the 100000-token price break/);
    const clean = await db.query<{ n: string }>("select count(*) as n from usage_events where pricing_note is null");
    expect(Number(clean.rows[0]!.n)).toBe(4);
  });

  it("keeps an append-only snapshot of every pricing configuration, keyed by content hash", async () => {
    const pricing = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const snap = await db.query<{ version: string; config: { version: string } }>(
      "select version, config from pricing_snapshots where hash = $1",
      [pricing.hash],
    );
    expect(snap.rows[0]!.version).toBe("test-v1");
    expect(snap.rows[0]!.config.version).toBe("test-v1");
    const joined = await db.query<{ n: string }>(
      "select count(*) as n from usage_events u join pricing_snapshots p on p.hash = u.pricing_hash",
    );
    expect(Number(joined.rows[0]!.n)).toBe(5);
  });
});

describe("weekly budget report", () => {
  it("sums the ISO week of 5 Oct 2026 and flags it over the $10 cap", async () => {
    const rows = await db.query<{ week_start: string; spend_micro_usd: string; over_cap: boolean }>(
      "select week_start::text, spend_micro_usd::text, over_cap from weekly_spend where team_id = $1 order by week_start",
      [team],
    );
    // Anthropic fixture: sonnet (1.2M*$2 + 0.1M cache write*$2.5 + 0.8M cache read*$0.2 + 0.3M*$10)/1M = $5.81
    //                  + opus (50k*$10 + 20k*$50)/1M = $1.50 + haiku on the BATCH tier (4M*$0.5 + 1M*$2.5)/1M × 0.5 = $2.25 → $9.56
    const oct2026 = rows.rows.find((r) => r.week_start === "2026-10-05");
    expect(oct2026).toBeDefined();
    expect(oct2026!.spend_micro_usd).toBe(String(9_560_000));
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
    // alice and bob hold seats and used Anthropic; the third seat's holder did not
    expect(anthropicOct).toMatchObject({
      paid_seats: 3,
      active_users: 2,
      active_seat_holders: 2,
      idle_seats: 1,
      active_users_without_seat: 0,
      over_subscribed: false,
    });
    expect(anthropicOct!.seat_cost_full_month_micro_usd).toBe(String(60 * MICRO));
    expect(anthropicOct!.seat_cost_prorated_micro_usd).toBe(String(60 * MICRO)); // all three seats active the whole month
    expect(anthropicOct!.usage_cost_micro_usd).toBe(String(9_560_000));
    expect(anthropicOct!.unattributed_cost_micro_usd).toBe("0");
    expect(Number(anthropicOct!.attribution_coverage)).toBe(1);
  });

  it("reports attribution coverage and unattributed spend instead of hiding unmapped users", async () => {
    const rows = await seatUseReport(db, { teamId: team, months: 14 });
    const openaiOct = rows.find((r) => r.provider === "openai" && r.month_start === "2025-10-01");
    // key_dave was unmapped: his $1.05 (90k*$5 + 30k*$20)/1M is counted in usage cost but not attributed.
    // The one OpenAI seat is alice's, but the usage was carol's: alice's seat is idle and carol has none.
    expect(openaiOct).toMatchObject({
      paid_seats: 1,
      active_users: 1,
      active_seat_holders: 0,
      idle_seats: 1,
      active_users_without_seat: 1,
      over_subscribed: true,
    });
    expect(openaiOct!.usage_cost_micro_usd).toBe(String(4_200_000));
    expect(openaiOct!.unattributed_cost_micro_usd).toBe(String(1_050_000));
    expect(Number(openaiOct!.attribution_coverage)).toBe(0.5);
  });


  it("counts a usage-only month with no seats as zero paid seats", async () => {
    const rows = await db.query<{ paid_seats: number; active_users: number }>(
      "select paid_seats, active_users from seat_use where team_id = $1 and provider = 'openai' and month_start = '2025-10-01'",
      [team],
    );
    // One paid openai seat (alice) but the usage was from carol (mapped) and dave (unmapped, so not counted as a user)
    expect(rows.rows[0]).toEqual({ paid_seats: 1, active_users: 1 });
  });

  it("flags months with more active users than paid seats rather than clamping silently", async () => {
    // Add a second mapped OpenAI user for Oct 2025 by re-importing with dave mapped: 2 active users, 1 seat.
    const pricing = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const openai = priceRecords(pricing, parseOpenAiUsage(await load("openai-completions-usage.json"))).priced;
    await upsertUsage(db, team, openai, { ...principals, key_dave: newUserId() });
    const rows = await seatUseReport(db, { teamId: team, months: 14 });
    const openaiOct = rows.find((r) => r.provider === "openai" && r.month_start === "2025-10-01");
    expect(openaiOct).toMatchObject({ paid_seats: 1, active_users: 2, idle_seats: 1, active_users_without_seat: 2, over_subscribed: true });
    expect(Number(openaiOct!.attribution_coverage)).toBe(1);
  });

  it("counts a seat as idle when its holder did not use it, even if other people did", async () => {
    // The case the earlier view got wrong: two seat holders who never use the provider,
    // two people without seats who do. That is two idle seats, not zero.
    const t = await createTeam(db, newUserId(), "Idle check");
    const [holder1, holder2, user1, user2] = [newUserId(), newUserId(), newUserId(), newUserId()];
    await db.query(
      `insert into seats (team_id, user_id, provider, monthly_cost_micro_usd, active_from)
         values ($1, $2, 'anthropic', $4, '2026-09-01'), ($1, $3, 'anthropic', $4, '2026-09-01')`,
      [t, holder1, holder2, 25 * MICRO],
    );
    await db.query(
      `insert into usage_events (team_id, user_id, provider, model, external_id, cost_micro_usd, occurred_at)
         values ($1, $2, 'anthropic', 'm', 'idle-check-1', 1000, '2026-09-10'), ($1, $3, 'anthropic', 'm', 'idle-check-2', 1000, '2026-09-11')`,
      [t, user1, user2],
    );
    const rows = await seatUseReport(db, { teamId: t, months: 3 });
    const sep = rows.find((r) => r.month_start === "2026-09-01");
    expect(sep).toMatchObject({
      paid_seats: 2,
      active_users: 2,
      active_seat_holders: 0,
      idle_seats: 2,
      active_users_without_seat: 2,
      over_subscribed: true,
    });
    await db.query("delete from teams where id = $1", [t]); // later tests count every row
  });

  it("reports every month a seat is paid for, including months with no usage at all", async () => {
    // A seat since July with usage only in July: August onwards must still appear, fully idle.
    const t = await createTeam(db, newUserId(), "Quiet months");
    const holder = newUserId();
    await db.query("insert into seats (team_id, user_id, provider, monthly_cost_micro_usd, active_from, active_to) values ($1, $2, 'openai', $3, '2026-07-01', '2026-09-30')", [
      t,
      holder,
      20 * MICRO,
    ]);
    await db.query(
      "insert into usage_events (team_id, user_id, provider, model, external_id, cost_micro_usd, occurred_at) values ($1, $2, 'openai', 'm', 'quiet-1', 1000, '2026-07-05')",
      [t, holder],
    );
    const rows = await db.query<{ month_start: string; paid_seats: number; idle_seats: number; seat_cost_full_month_micro_usd: string }>(
      "select month_start::text, paid_seats, idle_seats, seat_cost_full_month_micro_usd::text from seat_use where team_id = $1 order by month_start",
      [t],
    );
    expect(rows.rows).toEqual([
      { month_start: "2026-07-01", paid_seats: 1, idle_seats: 0, seat_cost_full_month_micro_usd: String(20 * MICRO) },
      { month_start: "2026-08-01", paid_seats: 1, idle_seats: 1, seat_cost_full_month_micro_usd: String(20 * MICRO) },
      { month_start: "2026-09-01", paid_seats: 1, idle_seats: 1, seat_cost_full_month_micro_usd: String(20 * MICRO) },
    ]); // ends with the seat: no October row
    await db.query("delete from teams where id = $1", [t]);
  });

  it("prorates a seat that was active for only part of the month, and keeps the full-month figure alongside", async () => {
    // $31/month seat, active from 22 Oct: 10 of 31 days → $10.00 prorated, $31.00 full month.
    await db.query(
      "insert into seats (team_id, user_id, provider, monthly_cost_micro_usd, active_from) values ($1, $2, 'anthropic', $3, '2026-10-22')",
      [team, newUserId(), 31 * MICRO],
    );
    const rows = await seatUseReport(db, { teamId: team, months: 1 });
    const oct = rows.find((r) => r.provider === "anthropic" && r.month_start === "2026-10-01");
    expect(oct!.paid_seats).toBe(4);
    expect(oct!.seat_cost_full_month_micro_usd).toBe(String(91 * MICRO));
    expect(oct!.seat_cost_prorated_micro_usd).toBe(String(70 * MICRO));
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

describe("local alternative report", () => {
  it("aggregates monthly prompt and output volume per team, provider and model from imported usage", async () => {
    const { monthlyVolumes } = await import("../../src/reports/local.js");
    const vols = await monthlyVolumes(db, { teamId: team, months: 14, includeCurrent: true, now: new Date("2026-10-20T12:00:00Z") });
    const sonnet = vols.find((v) => v.model === "claude-sonnet-5-5-20260601");
    // 1.2M uncached + 100k cache write + 800k cache read = 2.1M prompt; 300k output
    expect(sonnet).toMatchObject({ provider: "anthropic", monthStart: "2026-10-01", promptTokens: 2_100_000n, outputTokens: 300_000n, daysInMonth: 31, monthToDate: true, daysCovered: 20 });
    expect(sonnet!.cloudCostMicroUsd).toBe(5_810_000n);
    const mini = vols.find((v) => v.model === "gpt-5-mini");
    expect(mini).toMatchObject({ promptTokens: 2_000_000n, outputTokens: 400_000n, monthStart: "2025-10-01", monthToDate: false, daysCovered: 31 });
  });
});

describe("local alternative report: months and human time", () => {
  it("excludes the current month by default and returns exactly the completed months asked for", async () => {
    const { monthlyVolumes } = await import("../../src/reports/local.js");
    // Pretend it is 20 Oct 2026: Oct 2026 is month-to-date, Oct 2025 is 12 completed months back.
    const now = new Date("2026-10-20T12:00:00Z");
    const completed = await monthlyVolumes(db, { teamId: team, months: 12, now });
    expect(completed.map((v) => v.monthStart)).not.toContain("2026-10-01");
    expect(completed.some((v) => v.monthStart === "2025-10-01")).toBe(true);
    expect(completed.every((v) => !v.monthToDate && v.daysCovered === v.daysInMonth)).toBe(true);

    const three = await monthlyVolumes(db, { teamId: team, months: 3, now });
    expect(three).toHaveLength(0); // Oct 2025 is older than 3 completed months; Oct 2026 is excluded

    const withCurrent = await monthlyVolumes(db, { teamId: team, months: 3, now, includeCurrent: true });
    const oct = withCurrent.filter((v) => v.monthStart === "2026-10-01");
    expect(oct.length).toBeGreaterThan(0);
    expect(oct.every((v) => v.monthToDate && v.daysCovered === 20 && v.daysInMonth === 31)).toBe(true);
  });

  it("records task outcomes under RLS and aggregates them per model", async () => {
    const { taskQuality } = await import("../../src/reports/local.js");
    await asUser(db, owner, async (tx) => {
      await tx.query(
        `insert into task_outcomes (team_id, provider, model, task, review_minutes, retries, accepted) values
           ($1, 'local', 'qwen3.8-27b-q4_k_m', 'digest', 20, 1, true),
           ($1, 'local', 'qwen3.8-27b-q4_k_m', 'digest', 40, 2, false),
           ($1, 'anthropic', 'claude-haiku-5-5', 'digest', 5, 0, true)`,
        [team],
      );
    });
    // the other team's owner cannot see or write them
    const foreign = await asUser(db, outsider, (tx) => tx.query("select 1 from task_outcomes"));
    expect(foreign.rowCount).toBe(0);
    await expect(
      asUser(db, outsider, (tx) =>
        tx.query("insert into task_outcomes (team_id, provider, model, task, review_minutes, accepted) values ($1, 'local', 'x', 'y', 1, true)", [team]),
      ),
    ).rejects.toThrow(/row-level security/);

    const q = await taskQuality(db, team);
    expect(q.get(`${team}|local|qwen3.8-27b-q4_k_m`)).toEqual({ attempts: 2, accepted: 1, avgReviewMinutes: 30, avgRetries: 1.5, acceptanceRate: 0.5 });
    expect(q.get(`${team}|anthropic|claude-haiku-5-5`)).toEqual({ attempts: 1, accepted: 1, avgReviewMinutes: 5, avgRetries: 0, acceptanceRate: 1 });

    const { taskCountsByMonth } = await import("../../src/reports/local.js");
    const counts = await taskCountsByMonth(db, team);
    const thisMonth = new Date().toISOString().slice(0, 7) + "-01";
    expect(counts.get(`${team}|anthropic|claude-haiku-5-5|${thisMonth}`)).toBe(1);
    expect(counts.get(`${team}|local|qwen3.8-27b-q4_k_m|${thisMonth}`)).toBe(2);
  });

  it("workload attestations are per month and scoped by RLS; only admins can write them", async () => {
    const { workloadAttestations } = await import("../../src/reports/local.js");
    expect((await workloadAttestations(db, team)).size).toBe(0);
    await asUser(db, owner, (tx) =>
      tx.query(
        `insert into workload_attestations (team_id, provider, model, month_start, complete) values ($1, 'anthropic', 'claude-haiku-5-5', '2026-10-01', true)`,
        [team],
      ),
    );
    expect(await workloadAttestations(db, team)).toEqual(new Set([`${team}|anthropic|claude-haiku-5-5|2026-10-01`]));
    // withdrawing it removes the month from the set
    await asUser(db, owner, (tx) =>
      tx.query("update workload_attestations set complete = false where team_id = $1", [team]),
    );
    expect((await workloadAttestations(db, team)).size).toBe(0);
    // a month start that is not the 1st is rejected
    await expect(
      asServiceRole(db, (tx) =>
        tx.query("insert into workload_attestations (team_id, provider, model, month_start, complete) values ($1, 'openai', 'x', '2026-10-15', true)", [team]),
      ),
    ).rejects.toThrow(/check constraint/);
    // the other team cannot see or write
    expect((await asUser(db, outsider, (tx) => tx.query("select 1 from workload_attestations"))).rowCount).toBe(0);
    await expect(
      asUser(db, outsider, (tx) =>
        tx.query("insert into workload_attestations (team_id, provider, model, month_start, complete) values ($1, 'openai', 'x', '2026-10-01', true)", [team]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
