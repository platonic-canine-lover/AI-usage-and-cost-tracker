#!/usr/bin/env tsx
/**
 * ai-usage CLI
 *
 *   pnpm cli import anthropic --team <uuid> --file usage.json --pricing pricing.json [--principals map.json]
 *   pnpm cli import openai    --team <uuid> --file usage.json --pricing pricing.json [--principals map.json]
 *   pnpm report weekly    [--team <uuid>] [--weeks 8]
 *   pnpm report seats     [--team <uuid>] [--months 6]
 *   pnpm cli team create --name "Platform" [--budget 250]
 *
 * All commands connect with DATABASE_URL. They are server-side tools, so they
 * run as the connection's own role (service_role on Supabase), which bypasses
 * RLS by design; RLS protects the API that team members talk to.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pg from "pg";
import { parsers, upsertUsage } from "./importers/index.js";
import { formatUsd, loadPricing, MICRO, priceRecords } from "./pricing.js";
import { renderSeats, renderWeekly, seatUseReport, weeklyBudgetReport } from "./reports/index.js";
import type { PrincipalMap, Provider } from "./types.js";

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

const program = new Command().name("ai-usage").description("Track AI API spend per team");

const importCmd = program.command("import").description("Import a provider usage export into usage_events");
for (const provider of ["anthropic", "openai"] as const satisfies readonly Provider[]) {
  importCmd
    .command(provider)
    .requiredOption("--team <uuid>", "team the usage belongs to")
    .requiredOption("--file <path>", "raw JSON response from the provider's usage API (one page or an array of pages)")
    .requiredOption("--pricing <path>", "pricing table JSON (see pricing.example.json)")
    .option("--principals <path>", "JSON map of provider api key / account ids to user uuids")
    .option("--allow-unknown-models", "import unknown models at zero cost instead of failing", false)
    .action(async (opts: { team: string; file: string; pricing: string; principals?: string; allowUnknownModels: boolean }) => {
      const json: unknown = JSON.parse(await readFile(opts.file, "utf8"));
      const records = parsers[provider](json);
      const table = await loadPricing(opts.pricing);
      const { priced, unknownModels } = priceRecords(table, records, { allowUnknownModels: opts.allowUnknownModels });
      const principalMap: PrincipalMap = opts.principals ? (JSON.parse(await readFile(opts.principals, "utf8")) as PrincipalMap) : {};

      const summary = await withDb((db) => upsertUsage(db, opts.team, priced, principalMap));
      const total = priced.reduce((s, r) => s + r.costMicroUsd, 0);
      console.log(`${provider}: ${summary.inserted} inserted, ${summary.updated} updated, ${formatUsd(total)} total`);
      if (unknownModels.length) console.warn(`unpriced models (cost recorded as $0): ${unknownModels.join(", ")}`);
      if (summary.unmappedPrincipals.length)
        console.warn(`principals with no user mapping (user_id left null): ${summary.unmappedPrincipals.join(", ")}`);
    });
}

const report = program.command("report").description("Print a report");
report
  .command("weekly")
  .description("Spend per team per ISO week against the weekly cap")
  .option("--team <uuid>")
  .option("--weeks <n>", "how many weeks back", "8")
  .option("--json", "output JSON instead of a table", false)
  .action(async (opts: { team?: string; weeks: string; json: boolean }) => {
    const rows = await withDb((db) => weeklyBudgetReport(db, { ...(opts.team && { teamId: opts.team }), weeks: Number(opts.weeks) }));
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderWeekly(rows));
    if (rows.some((r) => r.over_cap)) process.exitCode = 2;
  });
report
  .command("seats")
  .description("Paid seats vs active users per provider per month")
  .option("--team <uuid>")
  .option("--months <n>", "how many months back", "6")
  .option("--json", "output JSON instead of a table", false)
  .action(async (opts: { team?: string; months: string; json: boolean }) => {
    const rows = await withDb((db) => seatUseReport(db, { ...(opts.team && { teamId: opts.team }), months: Number(opts.months) }));
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderSeats(rows));
  });

const team = program.command("team").description("Manage teams (server-side)");
team
  .command("create")
  .requiredOption("--name <name>")
  .option("--budget <usd>", "weekly cap in USD")
  .action(async (opts: { name: string; budget?: string }) => {
    const id = await withDb(async (db) => {
      const res = await db.query<{ id: string }>("insert into teams (name) values ($1) returning id", [opts.name]);
      const teamId = res.rows[0]!.id;
      if (opts.budget) {
        await db.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, $2)", [teamId, Math.round(Number(opts.budget) * MICRO)]);
      }
      return teamId;
    });
    console.log(id);
  });

await program.parseAsync(process.argv);
