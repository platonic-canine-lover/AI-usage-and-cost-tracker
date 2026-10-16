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

This repository is that process as code: an internal tool, small, tested,
and safe to point at more than one team's data. It is a reporting foundation,
not a product; the section "What this is and is not" draws the line.

## What it does

| Piece | Where | Proof |
| --- | --- | --- |
| Versioned schema migrations, run from scratch in CI on local Supabase and on plain Postgres 15, 16 and 17 | `supabase/migrations/` | `.github/workflows/ci.yml` |
| Row-level security: a member of team A cannot see, count, sum, write to or infer team B's spend | `20261016000200_row_level_security.sql` | `test/db/rls.team-isolation.test.ts` (10 cases) |
| Importers for the Anthropic Admin usage report and the OpenAI completions usage API; idempotent on re-import, one owning team per record, truncated exports rejected | `src/importers/` | `test/unit/importers.test.ts`, `test/db/import-and-reports.test.ts` |
| Pricing per token category (input, cache write, extended cache write, cache read, output) from a config file; exact decimal parsing, BigInt arithmetic; version and content hash stamped on every row, full config kept in `pricing_snapshots` | `src/pricing.ts`, `pricing.example.json` | unit tests |
| Weekly budget cap per team (retrospective), with an `over_cap` flag and a non-zero exit code for pipelines | `weekly_spend` view, `pnpm report weekly` | `test/db/import-and-reports.test.ts` |
| Seat-use report: paid seats vs people who actually generated usage, per provider per month, with attribution coverage, over-subscription flagged, and both full-month and day-prorated seat cost estimates | `seat_use` view, `pnpm report seats` | same |

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
 ✓ test/db/import-and-reports.test.ts (14 tests)
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
2. **Whole exports only, and they have to say so.** Both provider APIs
   paginate. Every page you pass must carry `has_more`; every non-final page
   must have `has_more: true` and a `next_page` cursor; the final page must
   have `has_more: false` and no cursor. Anything else fails with
   `IncompleteExportError`. `--allow-partial` overrides all of it and the
   summary prints a warning. An incomplete cost report that looks complete is
   worse than no report.
3. **Priced per category, or refused.** Input, short cache writes, extended
   cache writes, cache reads and output are stored and priced separately.
   A known model with tokens in a category that has no rate in the pricing
   file fails the import (`UnpricedCategoryError`): a cache write is never
   silently priced at the input rate. Unknown models fail unless
   `--allow-unknown-models`, in which case they are imported at $0 and listed.
   Every row records the pricing `version` label and the file's content hash,
   and the full configuration is kept in `pricing_snapshots` keyed by hash,
   so a reused label cannot make a historical figure unreproducible.

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
2026-10-05  Platform             $11.81      $10.00      OVER CAP
2025-09-29  Platform             $4.20       $10.00      ok

Month       Team                 Provider   Paid  Active  Idle  Seats (full) Seats (pro)  Usage cost  Per active  Coverage  Note
2026-10-01  Platform             anthropic  3     2       1     $60.00       $60.00       $11.81      $5.91       100%
2025-10-01  Platform             openai     1     1       0     $30.00       $30.00       $4.20       $3.15       50%       $1.05 unattributed
```

The anthropic line is the per-seat vs usage-based question as data: three paid
seats, two people using them, and the active ones generating about six dollars
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

## Would a local model be cheaper?

`pnpm report local --alternatives alternatives.json` takes each team's monthly
token volume per cloud model and asks what the same volume would cost, and
how long it would take, on a local model on a machine you own. The shipped
`alternatives.example.json` describes Qwen3.8-27B at Q4_K_M on a Mac mini M6
with 32 GB, with a source on every figure.

```
2026-10-01  Platform  anthropic/claude-haiku-5-5  →  Qwen3.8-27B (Q4_K_M) on Mac mini M6, 32 GB
  volume      4,000,000 prompt tokens, 1,000,000 output tokens
  cloud cost  $4.50
  local time  3.9 days of 31.0 days available  (13% utilisation)  [throughput estimate: 19 prompt tok/s, 8 gen tok/s]
  local cost  $39.02 dedicated ($2.93 energy + $36.08 hardware/month), $7.45 if shared (hardware prorated by utilisation)
  memory      17 GB model in 32 GB (6 GB headroom): fits
  benchmarks  (local score / cloud score, both as published; not a probability)
    SWE-bench Pro                61.7     vs cloud score not supplied
```

How it is worked out, and what it will not do:

- Prompt tokens are everything the model has to read (uncached input plus
  cache writes and cache reads: a local run gets no cache discount), output
  tokens are generated. Time is prompt ÷ prompt tok/s plus output ÷ generation
  tok/s, divided by the machine's concurrency. Utilisation above 100% is
  printed as CANNOT KEEP UP.
- Local cost is energy (active watts while busy, idle watts the rest of the
  month, at your tariff) plus hardware amortised over the months you choose,
  shown both as a dedicated machine and prorated by utilisation.
- Every throughput, power and size figure in the alternatives file carries a
  `basis` of `measured`, `estimate` or `spec` and a source URL. The report
  prints the basis and warns when anything is not measured, because time and
  cost scale directly with it. The example file's throughput for the M6 mini
  is an estimate (nobody had published a measurement for that pairing when it
  was written): a bandwidth ceiling of 170 GB/s ÷ 17 GB ≈ 10 tok/s generation,
  taken at about 80%, and prompt processing scaled by GPU-core count from the
  one published Mac measurement. Replace both with `llama-bench` output from
  the actual machine before believing a single number.
- "Likelihood of success" is not a number this tool will give you. It prints
  the local model's published benchmark scores next to the cloud model's on
  the same benchmark, where you have supplied the cloud score, and the ratio.
  Published scores are vendor-reported, on different harnesses, on tasks that
  are not yours. The example file leaves the cloud scores empty rather than
  copy figures the comparison articles assert but do not print. The way to
  find out whether the local model can do your work is to run your work
  through it and judge the output, which is what the cross-model judging tool
  is for.

## What this is and is not

| Capability | Status |
| --- | --- |
| Import Anthropic and OpenAI usage exports | Implemented |
| Per-category pricing with exact decimal parsing, integer money, content-hashed audit snapshots | Implemented; not reconciled against a provider invoice |
| Weekly cap report, exit code for pipelines | Implemented, **retrospective** |
| Seat-use report with attribution coverage and full-month / prorated seat cost estimates | Implemented; estimates, not invoice figures |
| Team-scoped row-level security | Implemented and tested; not yet adversarially reviewed by a third party |
| Fetching from the provider APIs on a schedule | Not implemented: you pass the JSON you fetched |
| Live spend enforcement (blocking calls at the cap) | Not implemented, and out of scope here; it needs a check in the request path, not a report |
| Local-model comparison (time, energy, amortised hardware, benchmark parity) | Implemented; throughput figures must be measured by you |
| Alerts, notifications, dashboard, onboarding | Not implemented |

The weekly cap flags a team after the spend is imported. If you need calls
refused at the cap, that is a separate mechanism that sits in front of the
provider; this repository can supply the numbers it consults.

## Design notes

- Money is `bigint` micro-USD. Provider prices run to fractions of a cent per
  token, and summing floats across a month's events drifts. Integers do not.
- Cost maths has no floating-point step. Prices are parsed from their decimal
  text (strings preferred; JSON numbers go through their shortest decimal
  form) into integer pico-USD per token, which is exact for up to 6 decimal
  places of USD per million tokens; more is rejected. Cost is tokens × rate
  summed in BigInt and rounded half-up to micro-USD once per line. There is no
  safe-integer ceiling.
- Prices are not hard-coded. They change, and a stale constant silently wrongs
  every report. Reconciling the pricing file against a real invoice for each
  model, service tier and cache tier is a step you own: this repository has
  not been reconciled against a provider bill, and does not claim billing
  accuracy. The `pricing_hash` column and `pricing_snapshots` table tell you
  exactly which rows a correction would need to re-price, and with what.
- Not priced: Anthropic server-side tool use (web search requests) and
  OpenAI audio or image sub-totals, which are either per-request charges or
  folded into the token totals at the text rate. The parsers document this.
- Seat costs are estimates from the `seats` table, never invoice figures.
  `seat_cost_full_month` charges every seat active at any point in the month
  its full monthly price; `seat_cost_prorated` scales by active days. Pick
  whichever matches how your provider bills; neither replaces the invoice.
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
supabase/migrations/   versioned SQL, applied in order (five so far; 000400 and 000500 are review follow-ups applied incrementally)
scripts/               migrate.ts (plain Postgres runner), reset.ts, auth-shim.sql
src/importers/         anthropic.ts, openai.ts, index.ts (upsert)
src/pricing.ts         pricing table, micro-dollar maths
src/reports/           weekly cap, seat-use and local-alternative queries and renderers
src/alternatives.ts    local model / machine schema and the time-and-cost estimate
src/cli.ts             commander CLI
test/db/               harness.ts, RLS isolation, import and reports
test/unit/             parsers and pricing
test/fixtures/         synthetic provider exports, test pricing, principal map
```

## Licence

MIT.
