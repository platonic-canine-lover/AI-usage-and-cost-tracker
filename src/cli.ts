#!/usr/bin/env tsx
/**
 * ai-usage CLI
 *
 *   pnpm cli import anthropic --team <uuid> --file usage.json --pricing pricing.json [--principals map.json]
 *   pnpm cli import openai    --team <uuid> --file usage.json --pricing pricing.json [--principals map.json]
 *   pnpm report weekly    [--team <uuid>] [--weeks 8]
 *   pnpm report seats     [--team <uuid>] [--months 6]
 *   pnpm report local     --alternatives alternatives.json [--team <uuid>] [--months 3] [--include-current]
 *   pnpm cli task record  --team <uuid> --model local:qwen3.8-27b-q4_k_m --task "weekly digest" --review-minutes 12 --accepted
 *   pnpm cli task attest  --team <uuid> --model anthropic:claude-haiku-5-5 --month 2026-09 --complete
 *   pnpm cli team create --name "Platform" [--budget 250]
 *
 * All commands connect with DATABASE_URL. They are server-side tools, so they
 * run as the connection's own role (service_role on Supabase), which bypasses
 * RLS by design; RLS protects the API that team members talk to. Keep that
 * connection string on the server.
 *
 * Reports are retrospective: they describe imported usage. Nothing here
 * blocks an API call in flight.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pg from "pg";
import { z } from "zod";
import { parsers, upsertUsage } from "./importers/index.js";
import { formatUsd, loadPricing, priceRecords, sumMicroUsd } from "./pricing.js";
import { loadAlternatives } from "./alternatives.js";
import { assertUuid, assertWindow, renderSeats, renderWeekly, seatUseReport, weeklyBudgetReport } from "./reports/index.js";
import { localAlternativeReport, monthlyVolumes, renderLocal, taskCountsByMonth, taskQuality, workloadAttestations } from "./reports/local.js";
import type { Provider } from "./types.js";

const PrincipalMapSchema = z.record(z.string().min(1), z.string().uuid());

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
    .option("--allow-partial", "import an export whose last page has has_more=true instead of failing", false)
    .action(
      async (opts: {
        team: string;
        file: string;
        pricing: string;
        principals?: string;
        allowUnknownModels: boolean;
        allowPartial: boolean;
      }) => {
        const teamId = assertUuid(opts.team);
        const json: unknown = JSON.parse(await readFile(opts.file, "utf8"));
        const records = parsers[provider](json, { allowPartial: opts.allowPartial });
        const table = await loadPricing(opts.pricing);
        const { priced, unknownModels, pricingVersion, pricingHash } = priceRecords(table, records, { allowUnknownModels: opts.allowUnknownModels });
        const principalMap = opts.principals ? PrincipalMapSchema.parse(JSON.parse(await readFile(opts.principals, "utf8"))) : {};

        const summary = await withDb((db) =>
          upsertUsage(db, teamId, priced, principalMap, { pricing: { version: pricingVersion, hash: pricingHash, raw: table.raw } }),
        );
        console.log(
          `${provider}: ${summary.inserted} inserted, ${summary.updated} updated, ${formatUsd(sumMicroUsd(priced))} total ` +
            `(pricing ${pricingVersion}, ${pricingHash.slice(0, 19)})`,
        );
        if (opts.allowPartial) console.warn("WARNING --allow-partial set: pagination was not verified; this import may not cover the whole period");
        if (unknownModels.length) console.warn(`unpriced models (cost recorded as $0): ${unknownModels.join(", ")}`);
        if (summary.unmappedPrincipals.length)
          console.warn(`principals with no user mapping (user_id left null): ${summary.unmappedPrincipals.join(", ")}`);
      },
    );
}

const report = program.command("report").description("Print a report (retrospective, from imported usage)");
report
  .command("weekly")
  .description("Spend per team per ISO week against the weekly cap; exit code 2 if any team is over")
  .option("--team <uuid>")
  .option("--weeks <n>", "how many weeks back", "8")
  .option("--json", "output JSON instead of a table", false)
  .action(async (opts: { team?: string; weeks: string; json: boolean }) => {
    const rows = await withDb((db) =>
      weeklyBudgetReport(db, { ...(opts.team && { teamId: assertUuid(opts.team) }), weeks: assertWindow(Number(opts.weeks), "weeks") }),
    );
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderWeekly(rows));
    if (rows.some((r) => r.over_cap)) process.exitCode = 2;
  });
report
  .command("seats")
  .description("Paid seats vs active users per provider per month, with attribution coverage")
  .option("--team <uuid>")
  .option("--months <n>", "how many months back", "6")
  .option("--json", "output JSON instead of a table", false)
  .action(async (opts: { team?: string; months: string; json: boolean }) => {
    const rows = await withDb((db) =>
      seatUseReport(db, { ...(opts.team && { teamId: assertUuid(opts.team) }), months: assertWindow(Number(opts.months), "months", 120) }),
    );
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderSeats(rows));
  });

report
  .command("local")
  .description("What the same monthly token volume would cost, and how long it would take, on a local model and machine you own")
  .requiredOption("--alternatives <path>", "local models and machines JSON (see alternatives.example.json)")
  .option("--team <uuid>")
  .option("--months <n>", "how many completed months back", "3")
  .option("--include-current", "also show the current month, labelled month-to-date and scaled to elapsed days", false)
  .option("--json", "output JSON instead of text", false)
  .action(async (opts: { alternatives: string; team?: string; months: string; includeCurrent: boolean; json: boolean }) => {
    const alt = await loadAlternatives(opts.alternatives);
    const teamId = opts.team ? assertUuid(opts.team) : undefined;
    const { volumes, quality, counts, attested } = await withDb(async (db) => ({
      volumes: await monthlyVolumes(db, { ...(teamId && { teamId }), months: assertWindow(Number(opts.months), "months", 120), includeCurrent: opts.includeCurrent }),
      quality: await taskQuality(db, teamId),
      counts: await taskCountsByMonth(db, teamId),
      attested: await workloadAttestations(db, teamId),
    }));
    const estimates = localAlternativeReport(volumes, alt, quality, counts, attested);
    console.log(
      opts.json
        ? JSON.stringify(estimates, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)
        : renderLocal(estimates),
    );
    if (estimates.some((e) => e.throughputBasis !== "measured")) {
      console.warn("NOTE: at least one throughput figure is an estimate or a spec ceiling, not a measurement; time and cost scale directly with it.");
    }
  });

const task = program.command("task").description("Record what a result cost in human time, so the local report can price it");
task
  .command("record")
  .requiredOption("--team <uuid>")
  .requiredOption("--model <id>", "provider:model, e.g. anthropic:claude-sonnet-5-5 or local:<alternatives model id>")
  .requiredOption("--task <label>", "what the task was (1 to 200 characters)")
  .requiredOption("--review-minutes <n>", "minutes a person spent checking or correcting the result")
  .option("--retries <n>", "how many times it had to be re-run", "0")
  .option("--accepted", "the result was usable", false)
  .option("--rejected", "the result was not usable", false)
  .option("--user <uuid>", "who reviewed it")
  .option("--note <text>")
  .action(async (opts: { team: string; model: string; task: string; reviewMinutes: string; retries: string; accepted: boolean; rejected: boolean; user?: string; note?: string }) => {
    const teamId = assertUuid(opts.team);
    const m = /^(anthropic|openai|local):(.+)$/.exec(opts.model);
    if (!m) throw new RangeError(`--model must be provider:model with provider anthropic, openai or local, got "${opts.model}"`);
    if (opts.accepted === opts.rejected) throw new RangeError("pass exactly one of --accepted or --rejected");
    const minutes = Number(opts.reviewMinutes);
    const retries = Number(opts.retries);
    if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("--review-minutes must be a non-negative number");
    if (!Number.isInteger(retries) || retries < 0) throw new RangeError("--retries must be a non-negative integer");
    const id = await withDb(async (db) => {
      const res = await db.query<{ id: string }>(
        `insert into task_outcomes (team_id, user_id, provider, model, task, review_minutes, retries, accepted, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [teamId, opts.user ? assertUuid(opts.user, "user id") : null, m[1], m[2], opts.task.trim(), minutes, retries, opts.accepted, opts.note ?? null],
      );
      return res.rows[0]!.id;
    });
    console.log(id);
  });

task
  .command("attest")
  .description("State whether the task outcomes recorded for a month are the complete workload that month's cloud spend paid for; the combined TOTAL is suppressed without this")
  .requiredOption("--team <uuid>")
  .requiredOption("--model <id>", "provider:model, e.g. anthropic:claude-haiku-5-5")
  .requiredOption("--month <YYYY-MM>")
  .option("--complete", "every task in the month was recorded", false)
  .option("--incomplete", "only a sample was recorded (withdraws a previous attestation)", false)
  .option("--user <uuid>", "who is attesting")
  .option("--note <text>")
  .action(async (opts: { team: string; model: string; month: string; complete: boolean; incomplete: boolean; user?: string; note?: string }) => {
    const teamId = assertUuid(opts.team);
    const m = /^(anthropic|openai):(.+)$/.exec(opts.model);
    if (!m) throw new RangeError(`--model must be provider:model with provider anthropic or openai (attestations are about cloud months), got "${opts.model}"`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw new RangeError(`--month must be YYYY-MM, got "${opts.month}"`);
    if (opts.complete === opts.incomplete) throw new RangeError("pass exactly one of --complete or --incomplete");
    await withDb((db) =>
      db.query(
        `insert into workload_attestations (team_id, provider, model, month_start, complete, note, attested_by)
         values ($1, $2, $3, $4::date, $5, $6, $7)
         on conflict (team_id, provider, model, month_start) do update set
           complete = excluded.complete, note = excluded.note, attested_by = excluded.attested_by, attested_at = now()`,
        [teamId, m[1], m[2], `${opts.month}-01`, opts.complete, opts.note ?? null, opts.user ? assertUuid(opts.user, "user id") : null],
      ),
    );
    console.log(`${opts.model} ${opts.month}: ${opts.complete ? "attested complete" : "marked incomplete"}`);
  });

const team = program.command("team").description("Manage teams (server-side)");
team
  .command("create")
  .requiredOption("--name <name>")
  .option("--budget <usd>", "weekly cap in USD (positive number)")
  .action(async (opts: { name: string; budget?: string }) => {
    const name = opts.name.trim();
    if (name.length < 1 || name.length > 120) throw new RangeError("team name must be 1 to 120 characters");
    let capMicro: bigint | undefined;
    if (opts.budget !== undefined) {
      const usd = Number(opts.budget);
      if (!Number.isFinite(usd) || usd <= 0) throw new RangeError(`budget must be a positive number of dollars, got "${opts.budget}"`);
      capMicro = BigInt(Math.round(usd * 1_000_000));
    }
    const id = await withDb(async (db) => {
      await db.query("begin");
      try {
        const res = await db.query<{ id: string }>("insert into teams (name) values ($1) returning id", [name]);
        const teamId = res.rows[0]!.id;
        if (capMicro !== undefined) {
          await db.query("insert into budgets (team_id, weekly_cap_micro_usd) values ($1, $2)", [teamId, capMicro.toString()]);
        }
        await db.query("commit");
        return teamId;
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    });
    console.log(id);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
