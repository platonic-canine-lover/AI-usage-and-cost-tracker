# AI usage and cost tracker

Multi-tenant tracking of AI API spend, built on Postgres row-level security.
Import usage from Anthropic and OpenAI, price it, cap it weekly per team, and
find out which paid seats nobody is using.

[![CI](https://github.com/platonic-canine-lover/ai-usage-and-cost-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/platonic-canine-lover/ai-usage-and-cost-tracker/actions/workflows/ci.yml)

## Why this exists

Running an AI product, I watched API spend reach about £200 a day and then
brought it down to under £20 a month. None of that came from a single trick.
It came from seeing the numbers per team and per person, pricing every token
honestly (cache reads are not free, cache writes are not cheap), putting a cap
on each week before the invoice arrived, and noticing that most of the seats
we were paying for belonged to people who had not made a call all month.

This repository is that process as code: small, tested, and safe to point at
more than one team's data.

## What it does

| Piece | Where | Proof |
| --- | --- | --- |
| Versioned schema migrations, run from scratch in CI on local Supabase and on plain Postgres 15, 16 and 17 | `supabase/migrations/` | `.github/workflows/ci.yml` |
| Row-level security: a member of team A cannot see, count, sum, write to or infer team B's spend | `20261016000200_row_level_security.sql` | `test/db/rls.team-isolation.test.ts` (10 cases) |
| Importers for the Anthropic Admin usage report and the OpenAI completions usage API, idempotent on re-import | `src/importers/` | `test/unit/importers.test.ts` |
| Pricing from a config file in USD per million tokens, stored as integer micro-dollars | `src/pricing.ts`, `pricing.example.json` | unit tests |
| Weekly budget cap per team, with an `over_cap` flag and a non-zero exit code for pipelines | `weekly_spend` view, `pnpm report weekly` | `test/db/import-and-reports.test.ts` |
| Seat-use report: paid seats vs people who actually generated usage, per provider per month | `seat_use` view, `pnpm report seats` | same |

## The RLS guarantee

Every tenant table carries `team_id` and has `FORCE ROW LEVEL SECURITY`. The
policies call two `SECURITY DEFINER` helpers, `is_team_member(team_id)` and
`is_team_admin(team_id)`, so the `team_members` policy never recurses into
itself. The report views are `security_invoker`, so they inherit the same
boundary instead of quietly running as the view owner.

The test runs each query exactly as the Supabase API would: inside a
transaction with `SET LOCAL ROLE authenticated` and the user's JWT claims in
`request.jwt.claims`, so `auth.uid()` resolves to a real subject. The cases:

- team A's `SELECT` returns only team A's rows, even with `WHERE team_id = <B>`
- aggregates cannot leak: `SUM` and `COUNT` over everything equal team A's own totals
- the report views show only team A
- `teams`, `team_members` and `budgets` are scoped the same way
- an `INSERT` into team B fails with a row-level security error
- `UPDATE` and `DELETE` against team B affect zero rows, and B's data is untouched
- team A cannot add itself to team B's membership
- a signed-in user with no team sees nothing anywhere
- `service_role` (the importers and reports) sees both teams, as it should

```
pnpm test:db

 ✓ test/db/rls.team-isolation.test.ts (10 tests)
 ✓ test/db/import-and-reports.test.ts (6 tests)
```

## Quick start

```bash
pnpm install
cp .env.example .env            # DATABASE_URL
cp pricing.example.json pricing.json   # fill in current prices

# Option A: local Supabase (Docker)
supabase start && supabase db reset

# Option B: any Postgres 15+
pnpm migrate

TEAM=$(pnpm -s cli team create --name Platform --budget 250)   # $250 a week
pnpm cli import anthropic --team $TEAM --file usage.json --pricing pricing.json --principals principals.json
pnpm cli import openai    --team $TEAM --file usage.json --pricing pricing.json --principals principals.json
pnpm report weekly
pnpm report seats
```

`usage.json` is the raw response from
`GET /v1/organizations/usage_report/messages` (Anthropic, grouped by `model`
and `api_key_id`) or `GET /v1/organization/usage/completions` (OpenAI, grouped
by `model` and `api_key_id`). One page or an array of pages both work.
`principals.json` maps provider key or account ids to user uuids so the
seat-use report can tell who was active; unmapped principals are imported with
`user_id` null and listed in the output.

Example output on the committed fixtures:

```
Week        Team                 Spend       Cap         Status
2026-10-05  Platform             $11.76      $10.00      OVER CAP
2025-09-29  Platform             $4.20       $10.00      ok

Month       Team                 Provider   Paid  Active  Idle  Seat cost   Usage cost  Usage/active seat
2026-10-01  Platform             anthropic  3     2       1     $60.00      $11.76      $5.88
```

That last line is the per-seat vs usage-based question in one row: three paid
seats, two people using them, and the active ones generating under six dollars
of usage each. When usage per active seat is a fraction of the seat price, a
usage-based plan drives adoption (nobody is rationed by a licence) and costs
less; when it climbs past the seat price for a team, seats become the cheaper
way to let them keep going. The report makes that call per team, per provider,
per month, from data rather than instinct.

## Design notes

- Money is `bigint` micro-USD. Provider prices run to fractions of a cent per
  token, and summing floats across a month's events drifts. Integers do not.
- Prices are not hard-coded. They change, and a stale constant silently wrongs
  every report. Unknown models fail the import unless you opt in to importing
  them at zero cost, and those are then listed.
- Imports are idempotent on `(provider, external_id)`, where the id is a hash
  of the bucket and every group-by dimension. Re-running yesterday's export
  updates rather than double-counts.
- Weeks are ISO (Monday start) in UTC, matching how both providers bucket.
- The CLI is a server-side tool and runs as the connection's role
  (`service_role` on Supabase), which bypasses RLS. RLS protects the API that
  team members talk to; it is not a substitute for keeping the service key off
  the client.
- `scripts/migrate.ts` exists so the identical migration files can be applied
  to any Postgres, with a `schema_migrations` table and a refusal to skip or
  re-run a version. Supabase applies the same files itself. The CI matrix
  proves both paths from an empty database.

## Layout

```
supabase/migrations/   versioned SQL, applied in order
scripts/               migrate.ts (plain Postgres runner), reset.ts, auth-shim.sql
src/importers/         anthropic.ts, openai.ts, index.ts (upsert)
src/pricing.ts         pricing table, micro-dollar maths
src/reports/           weekly cap and seat-use queries and renderers
src/cli.ts             commander CLI
test/db/               harness.ts, RLS isolation, import and reports
test/unit/             parsers and pricing
test/fixtures/         synthetic provider exports, test pricing, principal map
```

## Licence

MIT.
