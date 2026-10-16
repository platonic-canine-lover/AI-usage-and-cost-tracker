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
more than one team's data. It is a reporting foundation, not a finished
cost-control service; the section "What this is and is not" draws the line.

## What it does

| Piece | Where | Proof |
| --- | --- | --- |
| Versioned schema migrations, run from scratch in CI on local Supabase and on plain Postgres 15, 16 and 17 | `supabase/migrations/` | `.github/workflows/ci.yml` |
| Row-level security: a member of team A cannot see, count, sum, write to or infer team B's spend | `20261016000200_row_level_security.sql` | `test/db/rls.team-isolation.test.ts` (10 cases) |
| Importers for the Anthropic Admin usage report and the OpenAI completions usage API; idempotent on re-import, one owning team per record, truncated exports rejected | `src/importers/` | `test/unit/importers.test.ts`, `test/db/import-and-reports.test.ts` |
| Pricing from a versioned config file in USD per million tokens, integer-only (BigInt) arithmetic, version stamped on every row | `src/pricing.ts`, `pricing.example.json` | unit tests |
| Weekly budget cap per team (retrospective), with an `over_cap` flag and a non-zero exit code for pipelines | `weekly_spend` view, `pnpm report weekly` | `test/db/import-and-reports.test.ts` |
| Seat-use report: paid seats vs people who actually generated usage, per provider per month, with attribution coverage and over-subscription flagged | `seat_use` view, `pnpm report seats` | same |

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
 ✓ test/db/import-and-reports.test.ts (12 tests)
```

## Import rules

Three rules keep the numbers trustworthy, and each has a test:

1. **One owning team per record.** A provider usage line is identified by
   `(provider, external_id)` and belongs to exactly one team. Re-importing it
   for the same team updates in place. Importing it for a different team
   raises `CrossTeamConflictError` and rolls back the whole batch, so a shared
   organisation export cannot be counted twice or quietly re-homed. The
   pre-check is backed by a row-level guard on the upsert itself
   (`WHERE usage_events.team_id = excluded.team_id`), so a concurrent import
   racing past the check still touches nothing.
2. **Whole exports only.** Both provider APIs paginate. If the last page you
   pass has `has_more: true`, or a non-final page claims to be the last, the
   import fails with `IncompleteExportError`. `--allow-partial` overrides it
   and the summary says so. An incomplete cost report that looks complete is
   worse than no report.
3. **Priced, or refused.** Unknown models fail the import unless
   `--allow-unknown-models`, in which case they are imported at $0 and listed.
   Every row records the `pricing_version` that produced its cost (declared in
   the pricing file, or a content hash), so any report can say which price
   list it was built from.

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

Month       Team                 Provider   Paid  Active  Idle  Seat cost   Usage cost  Per active  Coverage  Note
2026-10-01  Platform             anthropic  3     2       1     $60.00      $11.76      $5.88       100%
2025-10-01  Platform             openai     1     1       0     $30.00      $4.20       $3.15       50%       $1.05 unattributed
```

The anthropic line is the per-seat vs usage-based question as data: three paid
seats, two people using them, and the active ones generating under six dollars
of usage each. Usage per active seat a fraction of the seat price is the signal
that a usage-based plan would cost less and ration nobody; usage climbing past
the seat price is the signal to look at seats. The report gives you that
signal per team, per provider, per month. It is an input to the decision, not
the decision: plan limits, model availability, rate limits and contract terms
all belong in the same conversation.

The openai line shows the report refusing to flatter you. Half the events had
no user mapping, so the coverage column says 50% and the note says how much
money is unattributed. Idle-seat counts are only as good as the principal
map, and the report says so on every row rather than clamping to zero.

## What this is and is not

| Capability | Status |
| --- | --- |
| Import Anthropic and OpenAI usage exports | Implemented |
| Configurable, versioned pricing; integer money | Implemented |
| Weekly cap report, exit code for pipelines | Implemented, **retrospective** |
| Seat-use report with attribution coverage | Implemented |
| Team-scoped row-level security | Implemented and tested; not yet adversarially reviewed by a third party |
| Fetching from the provider APIs on a schedule | Not implemented: you pass the JSON you fetched |
| Live spend enforcement (blocking calls at the cap) | Not implemented, and out of scope here; it needs a check in the request path, not a report |
| Alerts, notifications, dashboard, onboarding | Not implemented |

The weekly cap flags a team after the spend is imported. If you need calls
refused at the cap, that is a separate mechanism that sits in front of the
provider; this repository can supply the numbers it consults.

## Design notes

- Money is `bigint` micro-USD. Provider prices run to fractions of a cent per
  token, and summing floats across a month's events drifts. Integers do not.
- Cost maths is BigInt end to end: USD per million tokens is exactly micro-USD
  per token, prices with decimals are carried at nano-USD precision, and each
  line rounds half-up once. There is no float path and no safe-integer ceiling.
- Prices are not hard-coded. They change, and a stale constant silently wrongs
  every report. Reconciling the pricing file against a real invoice for each
  model and service tier is a step you own; the `pricing_version` column tells
  you which rows a correction would need to re-price.
- Imports are idempotent on `(provider, external_id)`, where the id is a hash
  of the bucket and every group-by dimension. Re-running yesterday's export
  updates rather than double-counts, and only for the team that owns it.
- Weeks are ISO (Monday start) in UTC, matching how both providers bucket.
- The CLI is a server-side tool and runs as the connection's role
  (`service_role` on Supabase), which bypasses RLS. RLS protects the API that
  team members talk to; it is not a substitute for keeping the service key off
  the client. The CLI validates the team exists and owns the records before
  writing, and validates UUIDs, budgets and report windows, but anyone holding
  the service connection string can import into any team: that is an
  operational boundary, not an RLS one.
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
