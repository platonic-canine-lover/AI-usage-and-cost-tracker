/**
 * The headline guarantee: a member of team A cannot see, count, sum, write to
 * or even infer the existence of team B's spend.
 *
 * Each query runs as the `authenticated` role with a real JWT subject, which
 * is exactly what a Supabase API request looks like to Postgres.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUsage, asServiceRole, asUser, createTeam, freshDatabase, newUserId } from "./harness.js";

let db: pg.Client;
const alice = newUserId(); // owner of team A
const bob = newUserId(); // owner of team B
const carol = newUserId(); // signed in, member of nothing
let teamA: string;
let teamB: string;

beforeAll(async () => {
  db = await freshDatabase();
  teamA = await createTeam(db, alice, "Team A");
  teamB = await createTeam(db, bob, "Team B");
  await addUsage(db, { teamId: teamA, userId: alice, costMicroUsd: 1_000_000 });
  await addUsage(db, { teamId: teamA, userId: alice, costMicroUsd: 2_000_000 });
  await addUsage(db, { teamId: teamB, userId: bob, costMicroUsd: 50_000_000 });
  await asServiceRole(db, (tx) =>
    tx.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, 10000000), ($2, 99000000)", [teamA, teamB]),
  );
});

afterAll(async () => {
  await db.end();
});

describe("team isolation under RLS", () => {
  it("team A sees only its own usage events", async () => {
    const rows = await asUser(db, alice, (tx) => tx.query<{ team_id: string }>("select team_id from usage_events"));
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.every((r) => r.team_id === teamA)).toBe(true);
  });

  it("team A cannot read team B's events even when filtering by B's id", async () => {
    const rows = await asUser(db, alice, (tx) => tx.query("select * from usage_events where team_id = $1", [teamB]));
    expect(rows.rowCount).toBe(0);
  });

  it("aggregates cannot leak: sum over everything equals team A's own total", async () => {
    const res = await asUser(db, alice, (tx) =>
      tx.query<{ total: string; n: string }>("select coalesce(sum(cost_micro_usd), 0) as total, count(*) as n from usage_events"),
    );
    expect(res.rows[0]!.total).toBe("3000000");
    expect(res.rows[0]!.n).toBe("2");
  });

  it("report views inherit the same boundary (security_invoker)", async () => {
    const res = await asUser(db, alice, (tx) =>
      tx.query<{ team_id: string; spend_micro_usd: string }>("select team_id, spend_micro_usd from weekly_spend"),
    );
    expect(res.rows.map((r) => r.team_id)).toEqual([teamA]);
    expect(res.rows[0]!.spend_micro_usd).toBe("3000000");
  });

  it("team A cannot see team B in teams, team_members or budgets", async () => {
    const res = await asUser(db, alice, async (tx) => ({
      teams: (await tx.query<{ id: string }>("select id from teams")).rows.map((r) => r.id),
      members: (await tx.query<{ user_id: string }>("select user_id from team_members")).rows.map((r) => r.user_id),
      budgets: (await tx.query<{ team_id: string }>("select team_id from budgets")).rows.map((r) => r.team_id),
    }));
    expect(res.teams).toEqual([teamA]);
    expect(res.members).toEqual([alice]);
    expect(res.budgets).toEqual([teamA]);
  });

  it("team A cannot insert spend into team B", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query(
          `insert into usage_events (team_id, provider, model, external_id, cost_micro_usd, occurred_at)
           values ($1, 'openai', 'gpt', 'forged-1', 1, now())`,
          [teamB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("team A cannot update or delete team B's rows (affects zero rows, no error)", async () => {
    const res = await asUser(db, alice, async (tx) => ({
      updated: (await tx.query("update usage_events set cost_micro_usd = 0 where team_id = $1", [teamB])).rowCount,
      deleted: (await tx.query("delete from budgets where team_id = $1", [teamB])).rowCount,
    }));
    expect(res.updated).toBe(0);
    expect(res.deleted).toBe(0);

    const stillThere = await asServiceRole(db, (tx) =>
      tx.query<{ cost_micro_usd: string }>("select cost_micro_usd from usage_events where team_id = $1", [teamB]),
    );
    expect(stillThere.rows[0]!.cost_micro_usd).toBe("50000000");
  });

  it("team A cannot add itself to team B", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'owner')", [teamB, alice]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a signed-in user with no team sees nothing at all", async () => {
    const res = await asUser(db, carol, async (tx) => ({
      teams: (await tx.query("select 1 from teams")).rowCount,
      events: (await tx.query("select 1 from usage_events")).rowCount,
      seatUse: (await tx.query("select 1 from seat_use")).rowCount,
    }));
    expect(res).toEqual({ teams: 0, events: 0, seatUse: 0 });
  });

  it("service_role (server-side importers and reports) sees both teams", async () => {
    const res = await asServiceRole(db, (tx) => tx.query("select distinct team_id from usage_events"));
    expect(res.rowCount).toBe(2);
  });
});
