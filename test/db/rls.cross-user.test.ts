/**
 * Cross-user row-level security: what one signed-in user can do to another.
 *
 * rls.team-isolation.test.ts puts each user in a team of their own, so it
 * proves the wall between teams. This file covers the cases that one misses:
 * users who share a team but hold different roles, a user who belongs to two
 * teams, a user whose membership changes, and callers with no identity.
 *
 * Scope note: rows are scoped to the team, not to the person. A plain member
 * is meant to see their team-mates' usage; what they must not be able to do
 * is change it, change who is on the team, or raise their own role.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUsage, asServiceRole, asUser, createTeam, freshDatabase, newUserId, type Tx } from "./harness.js";

let db: pg.Client;
const alice = newUserId(); // owner of team A
const dave = newUserId(); // admin of team A
const erin = newUserId(); // plain member of team A
const frank = newUserId(); // plain member of team A and team B
const bob = newUserId(); // owner of team B
const carol = newUserId(); // signed in, member of nothing
const gina = newUserId(); // joins team A part-way through
let teamA: string;
let teamB: string;

/** Run as a role with no user behind it. Always rolled back. */
async function asRole<T>(role: "anon" | "authenticated", claims: object | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    if (claims) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await fn({ query: db.query.bind(db) });
  } finally {
    await db.query("rollback");
  }
}

/**
 * Rows a caller can read from `relation`. Plain Postgres gives anon no table
 * grant ("permission denied"); Supabase grants the table and lets RLS return
 * nothing. Both mean the caller reads nothing, so both count as 0.
 */
async function visibleRows(role: "anon" | "authenticated", claims: object | null, relation: string): Promise<number> {
  try {
    return (await asRole(role, claims, (tx) => tx.query(`select 1 from ${relation}`))).rowCount ?? 0;
  } catch (err) {
    if (/permission denied/.test(String(err))) return 0;
    throw err;
  }
}

const roleOf = async (teamId: string, userId: string) =>
  (
    await asServiceRole(db, (tx) =>
      tx.query<{ role: string }>("select role from team_members where team_id = $1 and user_id = $2", [teamId, userId]),
    )
  ).rows[0]?.role ?? null;

beforeAll(async () => {
  db = await freshDatabase();
  teamA = await createTeam(db, alice, "Team A");
  teamB = await createTeam(db, bob, "Team B");
  await asServiceRole(db, async (tx) => {
    await tx.query(
      `insert into team_members (team_id, user_id, role) values
         ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($2, $5, 'member')`,
      [teamA, teamB, dave, erin, frank],
    );
    await tx.query(
      `insert into seats (team_id, user_id, provider, monthly_cost_micro_usd) values
         ($1, $3, 'anthropic', 20000000), ($2, $4, 'openai', 30000000)`,
      [teamA, teamB, erin, bob],
    );
    await tx.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, 10000000), ($2, 99000000)", [teamA, teamB]);
  });
  await addUsage(db, { teamId: teamA, userId: alice, costMicroUsd: 1_000_000 });
  await addUsage(db, { teamId: teamA, userId: erin, costMicroUsd: 2_000_000 });
  await addUsage(db, { teamId: teamB, userId: bob, costMicroUsd: 50_000_000 });
});

afterAll(async () => {
  await db.end();
});

describe("a plain member and their team-mates", () => {
  it("reads the whole team's rows, team-mates' included, and nothing beyond the team", async () => {
    const res = await asUser(db, erin, async (tx) => ({
      events: (await tx.query<{ user_id: string; team_id: string }>("select user_id, team_id from usage_events")).rows,
      members: (await tx.query<{ user_id: string }>("select user_id from team_members")).rows.map((r) => r.user_id),
      seats: (await tx.query<{ team_id: string }>("select team_id from seats")).rows.map((r) => r.team_id),
    }));
    expect(res.events.map((r) => r.user_id).sort()).toEqual([alice, erin].sort());
    expect(res.events.every((r) => r.team_id === teamA)).toBe(true);
    expect(res.members.sort()).toEqual([alice, dave, erin, frank].sort());
    expect(res.seats).toEqual([teamA]);
  });

  it("cannot insert spend or a seat into their own team", async () => {
    await expect(
      asUser(db, erin, (tx) =>
        tx.query(
          `insert into usage_events (team_id, user_id, provider, model, external_id, cost_micro_usd, occurred_at)
           values ($1, $2, 'openai', 'gpt', 'member-forged-1', 1, now())`,
          [teamA, alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(db, erin, (tx) =>
        tx.query("insert into seats (team_id, user_id, provider, monthly_cost_micro_usd) values ($1, $2, 'openai', 0)", [teamA, erin]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot change or delete a team-mate's spend, the seats or the budget (zero rows, no error)", async () => {
    const res = await asUser(db, erin, async (tx) => ({
      othersSpend: (await tx.query("update usage_events set cost_micro_usd = 0 where user_id = $1", [alice])).rowCount,
      ownSpend: (await tx.query("delete from usage_events where user_id = $1", [erin])).rowCount,
      seat: (await tx.query("update seats set monthly_cost_micro_usd = 0 where team_id = $1", [teamA])).rowCount,
      budget: (await tx.query("update budgets set weekly_cap_micro_usd = 1 where team_id = $1", [teamA])).rowCount,
      budgetGone: (await tx.query("delete from budgets where team_id = $1", [teamA])).rowCount,
    }));
    expect(res).toEqual({ othersSpend: 0, ownSpend: 0, seat: 0, budget: 0, budgetGone: 0 });

    const after = await asServiceRole(db, async (tx) => ({
      total: (await tx.query<{ t: string }>("select sum(cost_micro_usd) as t from usage_events where team_id = $1", [teamA])).rows[0]!.t,
      cap: (await tx.query<{ c: string }>("select weekly_cap_micro_usd as c from budgets where team_id = $1", [teamA])).rows[0]!.c,
    }));
    expect(after).toEqual({ total: "3000000", cap: "10000000" });
  });

  it("cannot raise their own role", async () => {
    const updated = await asUser(db, erin, (tx) =>
      tx.query("update team_members set role = 'owner' where team_id = $1 and user_id = $2", [teamA, erin]),
    );
    expect(updated.rowCount).toBe(0);
    expect(await roleOf(teamA, erin)).toBe("member");
  });

  it("cannot add a user to the team, or remove or demote a team-mate", async () => {
    await expect(
      asUser(db, erin, (tx) => tx.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'member')", [teamA, carol])),
    ).rejects.toThrow(/row-level security/);

    const res = await asUser(db, erin, async (tx) => ({
      removed: (await tx.query("delete from team_members where team_id = $1 and user_id = $2", [teamA, dave])).rowCount,
      demoted: (await tx.query("update team_members set role = 'member' where team_id = $1 and user_id = $2", [teamA, alice])).rowCount,
    }));
    expect(res).toEqual({ removed: 0, demoted: 0 });
    expect(await roleOf(teamA, dave)).toBe("admin");
    expect(await roleOf(teamA, alice)).toBe("owner");
  });

  it("cannot rename or delete the team", async () => {
    const res = await asUser(db, erin, async (tx) => ({
      renamed: (await tx.query("update teams set name = 'Mine now' where id = $1", [teamA])).rowCount,
      deleted: (await tx.query("delete from teams where id = $1", [teamA])).rowCount,
    }));
    expect(res).toEqual({ renamed: 0, deleted: 0 });
  });

  it("can record a task outcome, but cannot edit or delete one a team-mate recorded", async () => {
    await asUser(db, alice, (tx) =>
      tx.query(
        `insert into task_outcomes (team_id, user_id, provider, model, task, review_minutes, accepted)
         values ($1, $2, 'anthropic', 'test-model', 'summarise', 4, true)`,
        [teamA, alice],
      ),
    );
    const res = await asUser(db, erin, async (tx) => {
      const inserted = await tx.query(
        `insert into task_outcomes (team_id, user_id, provider, model, task, review_minutes, accepted)
         values ($1, $2, 'anthropic', 'test-model', 'summarise', 9, false)`,
        [teamA, erin],
      );
      return {
        inserted: inserted.rowCount,
        edited: (await tx.query("update task_outcomes set accepted = false where user_id = $1", [alice])).rowCount,
        deleted: (await tx.query("delete from task_outcomes where user_id = $1", [alice])).rowCount,
      };
    });
    expect(res).toEqual({ inserted: 1, edited: 0, deleted: 0 });
  });
});

describe("an admin's reach stops at their own team", () => {
  it("an admin can add a member, who then sees the team's rows at once", async () => {
    await asUser(db, dave, (tx) =>
      tx.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'member')", [teamA, gina]),
    );
    const seen = await asUser(db, gina, (tx) => tx.query<{ team_id: string }>("select team_id from usage_events"));
    expect(seen.rowCount).toBe(2);
    expect(seen.rows.every((r) => r.team_id === teamA)).toBe(true);
  });

  it("an admin of team A cannot add anyone to team B, or read or change team B", async () => {
    await expect(
      asUser(db, dave, (tx) => tx.query("insert into team_members (team_id, user_id, role) values ($1, $2, 'admin')", [teamB, dave])),
    ).rejects.toThrow(/row-level security/);

    const res = await asUser(db, dave, async (tx) => ({
      seen: (await tx.query("select 1 from usage_events where team_id = $1", [teamB])).rowCount,
      seats: (await tx.query("update seats set monthly_cost_micro_usd = 0 where team_id = $1", [teamB])).rowCount,
      removed: (await tx.query("delete from team_members where team_id = $1", [teamB])).rowCount,
    }));
    expect(res).toEqual({ seen: 0, seats: 0, removed: 0 });
    expect(await roleOf(teamB, bob)).toBe("owner");
  });

  it("an admin cannot move a team-mate's spend to another team", async () => {
    await expect(
      asUser(db, dave, (tx) => tx.query("update usage_events set team_id = $1 where team_id = $2", [teamB, teamA])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("a user in two teams, and a membership that changes", () => {
  it("sees exactly the two teams they belong to", async () => {
    const res = await asUser(db, frank, async (tx) => ({
      teams: (await tx.query<{ id: string }>("select id from teams")).rows.map((r) => r.id),
      total: (await tx.query<{ t: string }>("select sum(cost_micro_usd) as t from usage_events")).rows[0]!.t,
      spendTeams: (await tx.query<{ team_id: string }>("select team_id from weekly_spend")).rows.map((r) => r.team_id),
    }));
    expect(res.teams.sort()).toEqual([teamA, teamB].sort());
    expect(res.total).toBe("53000000");
    expect(res.spendTeams.sort()).toEqual([teamA, teamB].sort());
  });

  it("membership of two teams gives write access to neither", async () => {
    const res = await asUser(db, frank, async (tx) => ({
      a: (await tx.query("update usage_events set cost_micro_usd = 0 where team_id = $1", [teamA])).rowCount,
      b: (await tx.query("update usage_events set cost_micro_usd = 0 where team_id = $1", [teamB])).rowCount,
    }));
    expect(res).toEqual({ a: 0, b: 0 });
  });

  it("loses sight of a team the moment its owner removes them", async () => {
    const removed = await asUser(db, bob, (tx) =>
      tx.query("delete from team_members where team_id = $1 and user_id = $2", [teamB, frank]),
    );
    expect(removed.rowCount).toBe(1);

    const res = await asUser(db, frank, async (tx) => ({
      teams: (await tx.query<{ id: string }>("select id from teams")).rows.map((r) => r.id),
      total: (await tx.query<{ t: string }>("select sum(cost_micro_usd) as t from usage_events")).rows[0]!.t,
      budgets: (await tx.query<{ team_id: string }>("select team_id from budgets")).rows.map((r) => r.team_id),
    }));
    expect(res).toEqual({ teams: [teamA], total: "3000000", budgets: [teamA] });
  });

  it("a member can leave, removing only their own membership, and then sees nothing", async () => {
    const left = await asUser(db, erin, (tx) => tx.query("delete from team_members where team_id = $1", [teamA]));
    expect(left.rowCount).toBe(1);
    expect(await roleOf(teamA, erin)).toBeNull();
    expect(await roleOf(teamA, alice)).toBe("owner");

    const res = await asUser(db, erin, async (tx) => ({
      teams: (await tx.query("select 1 from teams")).rowCount,
      events: (await tx.query("select 1 from usage_events")).rowCount,
      outcomes: (await tx.query("select 1 from task_outcomes")).rowCount,
      seats: (await tx.query("select 1 from seats")).rowCount,
    }));
    expect(res).toEqual({ teams: 0, events: 0, outcomes: 0, seats: 0 });
  });
});

describe("identity cannot be borrowed or left out", () => {
  it("a user cannot create a team in another user's name", async () => {
    await expect(
      asUser(db, carol, (tx) => tx.query("insert into teams (name, created_by) values ('Forged', $1)", [alice])),
    ).rejects.toThrow(/row-level security/);
  });

  it("creating a team makes the creator its only member, as owner", async () => {
    const teamC = await createTeam(db, carol, "Team C");
    const members = await asServiceRole(db, (tx) =>
      tx.query<{ user_id: string; role: string }>("select user_id, role from team_members where team_id = $1", [teamC]),
    );
    expect(members.rows).toEqual([{ user_id: carol, role: "owner" }]);
    const seen = await asUser(db, carol, (tx) => tx.query<{ id: string }>("select id from teams"));
    expect(seen.rows.map((r) => r.id)).toEqual([teamC]);
  });

  it("a signed-in request with no user id in its token reads nothing and cannot create a team", async () => {
    const claims = { role: "authenticated" };
    for (const relation of ["teams", "team_members", "usage_events", "seats", "budgets", "task_outcomes", "weekly_spend"]) {
      expect(await visibleRows("authenticated", claims, relation), relation).toBe(0);
    }
    await expect(
      asRole("authenticated", claims, (tx) => tx.query("insert into teams (name) values ('Nobody')")),
    ).rejects.toThrow(/row-level security/);
  });

  it("an anonymous request reads nothing and writes nothing", async () => {
    for (const relation of ["teams", "team_members", "usage_events", "seats", "budgets", "task_outcomes", "weekly_spend", "seat_use"]) {
      expect(await visibleRows("anon", null, relation), relation).toBe(0);
    }
    await expect(
      asRole("anon", null, (tx) =>
        tx.query(
          `insert into usage_events (team_id, provider, model, external_id, cost_micro_usd, occurred_at)
           values ($1, 'openai', 'gpt', 'anon-forged-1', 1, now())`,
          [teamA],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
  });
});
