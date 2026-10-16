/**
 * Database test harness.
 *
 * `asUser(client, userId, fn)` runs `fn` exactly the way PostgREST (and so the
 * Supabase API) runs a request from a signed-in user: inside a transaction,
 * with `SET LOCAL ROLE authenticated` and the JWT claims in
 * `request.jwt.claims`. RLS policies therefore see auth.uid() = userId.
 *
 * `asServiceRole` is the server-side path the importers and reports use:
 * service_role bypasses RLS, exactly as on Supabase.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

export function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; DB tests need a Postgres to talk to (see .env.example)");
  return url;
}

/**
 * Connect and return an empty, migrated database.
 *
 * If the schema is already there (CI applied it with `supabase db reset` or
 * `pnpm migrate`) the tenant tables are truncated. Otherwise the migrations
 * are applied. The schema is never dropped, so this is safe on a Supabase
 * database, which keeps its own objects in `public`.
 */
export async function freshDatabase(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  const exists = await client.query("select 1 from pg_tables where schemaname = 'public' and tablename = 'teams'");
  if (exists.rowCount) {
    await client.query("truncate public.teams, public.team_members, public.seats, public.usage_events, public.budgets cascade");
  } else {
    await migrate(client);
  }
  return client;
}

export type Tx = { query: pg.Client["query"] };

export async function asUser<T>(client: pg.Client, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await fn({ query: client.query.bind(client) });
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

export async function asServiceRole<T>(client: pg.Client, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const result = await fn({ query: client.query.bind(client) });
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

export const newUserId = () => randomUUID();

/** Create a team as `ownerId` through the authenticated path (trigger adds them as owner). */
export async function createTeam(client: pg.Client, ownerId: string, name: string): Promise<string> {
  return asUser(client, ownerId, async (tx) => {
    const res = await tx.query<{ id: string }>("insert into teams (name) values ($1) returning id", [name]);
    return res.rows[0]!.id;
  });
}

export async function addUsage(
  client: pg.Client,
  row: { teamId: string; userId?: string; provider?: "anthropic" | "openai"; costMicroUsd: number; occurredAt?: string },
) {
  await asServiceRole(client, (tx) =>
    tx.query(
      `insert into usage_events (team_id, user_id, provider, model, external_id, cost_micro_usd, occurred_at)
       values ($1, $2, $3, 'test-model', $4, $5, $6)`,
      [
        row.teamId,
        row.userId ?? null,
        row.provider ?? "anthropic",
        randomUUID(),
        row.costMicroUsd,
        row.occurredAt ?? new Date().toISOString(),
      ],
    ),
  );
}
