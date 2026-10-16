/**
 * Drop everything the migrations created and re-apply from scratch.
 * Plain-Postgres equivalent of `supabase db reset`. Destructive by design;
 * refuses to run unless the database name contains "test" or "ai_usage"
 * or RESET_CONFIRM=yes is set.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.js";

export async function resetDatabase(client: pg.Client) {
  await client.query(`
    drop schema if exists public cascade;
    create schema public;
    grant all on schema public to public;
  `);
  return migrate(client);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (see .env.example)");
    process.exit(1);
  }
  const dbName = new URL(url).pathname.slice(1);
  if (!/test|ai_usage/.test(dbName) && process.env.RESET_CONFIRM !== "yes") {
    console.error(`Refusing to reset "${dbName}". Set RESET_CONFIRM=yes if you mean it.`);
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await resetDatabase(client);
    console.log(`reset ${dbName}; applied ${applied.length} migration(s)`);
  } finally {
    await client.end();
  }
}
