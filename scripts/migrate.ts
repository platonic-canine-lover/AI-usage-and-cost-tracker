/**
 * Versioned migration runner for plain Postgres.
 *
 * Supabase applies `supabase/migrations/*.sql` itself (`supabase db reset`, or
 * `supabase db push` for hosted projects). This runner exists so the identical
 * files can be applied to any Postgres: the CI matrix job, or a developer
 * without Docker. It records each applied file in `schema_migrations` and
 * refuses to re-run or skip one.
 *
 *   pnpm migrate            # apply pending migrations from DATABASE_URL
 *   pnpm migrate --dry-run  # list what would be applied
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../supabase/migrations");
const AUTH_SHIM = path.resolve(here, "auth-shim.sql");

export async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith(".sql")).sort();
}

export async function migrate(client: pg.Client, opts: { dryRun?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);

  await client.query(await readFile(AUTH_SHIM, "utf8"));
  await client.query(`
    create table if not exists public.schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )`);

  const applied = new Set(
    (await client.query<{ version: string }>("select version from public.schema_migrations order by version")).rows.map(
      (r) => r.version,
    ),
  );

  const files = await listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  // A file that was applied but is no longer on disk means someone edited history.
  for (const v of applied) {
    if (!files.includes(v)) throw new Error(`Applied migration ${v} is missing from ${MIGRATIONS_DIR}`);
  }

  if (pending.length === 0) {
    log("No pending migrations.");
    return [];
  }

  for (const file of pending) {
    if (opts.dryRun) {
      log(`would apply ${file}`);
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public.schema_migrations (version) values ($1)", [file]);
      await client.query("commit");
      log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return pending;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (see .env.example)");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, { dryRun: process.argv.includes("--dry-run"), log: console.log });
  } finally {
    await client.end();
  }
}
