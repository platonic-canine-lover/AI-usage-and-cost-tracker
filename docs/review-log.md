# Review log

This repository was built in one day, 16 October 2026, as a series of
commits, each one a response to an independent code review of the previous
state. The reviewer inspected the code and tests but could not run them;
every commit below was verified locally (typecheck, lint, 73 tests against
Postgres 16) before it was handed back. The log is here because the
corrections say more about the engineering than the first draft does.

## Commit 1: first build

Schema with forced row-level security per team and `security_invoker`
views; a ten-case isolation test run as the `authenticated` role with JWT
claims the way PostgREST does it; importers for the Anthropic and OpenAI
usage APIs; pricing from a config file; weekly cap and seat-use reports;
CI on local Supabase and plain Postgres 15/16/17.

## Review 1 → commit 2

| Finding | Severity | Fix |
| --- | --- | --- |
| Upsert key `(provider, external_id)` crossed team boundaries: a second team importing the same record silently updated the first team's row | High | A record belongs to exactly one team. Pre-check raises `CrossTeamConflictError` and rolls back; the upsert carries `WHERE usage_events.team_id = excluded.team_id` so a concurrent import cannot re-home a row. Both tested, including a simulated race. |
| Importers accepted a page with `has_more: true`, so a partial export looked complete | High | Rejected unless `--allow-partial`. |
| Pricing used float arithmetic before storing integers; no provenance | High | BigInt arithmetic; `pricing_version` stamped on every row (migration 000400). |
| Seat report clamped idle seats to zero and hid unmapped users | Medium | Attribution coverage, unattributed spend and `over_subscribed` added. |
| No validation of team ids, budgets, windows; reports implied live control | Medium | Validated; README states reports are retrospective and has a "what this is and is not" table. |

## Review 2 → commit 3

| Finding | Severity | Fix |
| --- | --- | --- |
| Anthropic cache-write tokens were folded into input and priced at the input rate, understating cost | High | Five token categories stored and priced separately (migration 000500). A category with tokens but no configured rate fails the import. A test shows the understatement the reviewer predicted ($9.75 vs $6.00 on 2M cache-write tokens). |
| Pagination check accepted a final page with `has_more` omitted | Medium | `has_more` required on every page; non-final pages need `true` plus a cursor; the final page needs `false` and no cursor. |
| "Integer-only" pricing still parsed prices through JavaScript numbers | Medium | Prices parse from decimal text into integer pico-USD per token; six decimal places supported, more rejected; tests at the smallest increment and the half-up boundary. |
| Monthly seat cost counted a seat active for one day at full price | Medium | Both full-month and day-prorated figures, documented as estimates. |
| A reused version label could make a historical cost unreproducible | Low | Content hash stamped on rows; `pricing_snapshots` keeps every configuration. |

## Commit 4: local-model comparison

`report local` compares a month's cloud token volume with running the same
volume on a local model on a machine you own: wall-clock time, utilisation,
energy, amortised hardware, memory fit, benchmark parity. Every figure in
the alternatives file carries a basis (`measured`, `estimate`, `spec`) and a
source; the report prints the basis and warns when anything is unmeasured.

## Review 3 → commit 5

| Finding | Fix |
| --- | --- |
| No human time: a local model can be cheap per token and expensive per finished task | `task_outcomes` table and `cli task record` (review minutes, retries, accepted/rejected) for cloud and local models; the report prices review time per attempt and per accepted result, local beside cloud, marked recorded / assumed / none, never folded into machine time. |
| Memory check compared weights alone against RAM | KV cache sized for the working context plus runtime overhead when figures are supplied; otherwise "weights fit; full-context feasibility unverified". |
| Current, incomplete month compared against full-month local costs; "3 months" returned 4 | Completed months only by default; `--include-current` labels the current month MONTH-TO-DATE and scales hours, idle energy and hardware share to elapsed days. |

## Review 4 → commits 6 and 7

| Finding | Fix |
| --- | --- |
| One hourly rate is not a universal value for human time | `human.rates`: named rates in USD, GBP or EUR with a sourced FX figure. Example carries the UK National Living Wage (£12.71 from April 2026, GOV.UK) and a user-supplied £17/h engineer figure flagged as unverified. |
| Machine and human costs were shown separately, leaving the reader to add them | `TOTAL` line: estimated cost per accepted result, machine plus human, cloud vs local (dedicated and shared), computed only when the month's cloud tasks were recorded and both sides have review data, with every assumption listed beside the figure. |

## Review 5 → commit 8

| Finding | Fix |
| --- | --- |
| `combinedCost()` divided the month's cloud spend by the task outcomes recorded that month, which is only valid if those records are the whole workload; five representative tasks do not license dividing the bill by five | `workload_attestations` table (migration 000700) and `cli task attest --month --complete`: an explicit, per team/provider/model/month statement that the recorded outcomes cover the full workload. Without it the TOTAL is suppressed and the report lists what is missing; the attestation text appears in the figure's basis. Withdrawable with `--incomplete`. |

## Review 6 → commit 9

| Finding | Change |
| --- | --- |
| The pricing file had one rate per model, but Anthropic's usage export carries `service_tier` and `context_window`, and the importer only used them to build the row id. Haiku 5.5 charges five times as much per token above 100,000 tokens and batch requests are half price, so long prompts were priced at a fifth of their cost and batch at double. | Pricing is now a function of (model, context bucket, service tier). A model entry may carry `long_context` (a second rate set from a token threshold) and `service_tiers` (multipliers). Rows store `service_tier`, `context_window` and a `pricing_note` (migration 000800). An export not grouped by those fields is refused for a tiered model unless `--allow-ungrouped`, which prices at the base rate and flags the rows. A tier with no multiplier fails the import, so batch is never silently priced at full rate. |
| The export's context buckets (`0-200k`, `200k-1M`) do not line up with Haiku 5.5's 100k price break. | `200k-1M` gets the long-context rates. `0-200k` is priced at the base rate and the row's `pricing_note` says prompts over 100k inside it are under-priced. The import summary counts flagged rows. The gap cannot be closed from the usage export, and the README says so rather than rounding it off. |

The reviewer also raised the model id `claude-haiku-5-5`. It is current; the
reviewer's model list was out of date. The pricing example still names it.

## Review 7 (independent code scan) → commits 10 to 12

| Finding | Change |
| --- | --- |
| `idle_seats` was paid seats minus everyone with usage, seat or no seat. Two seat holders who never used the provider plus two people without seats who did reported 0 idle seats. | Migration 000900 counts per seat: a seat is idle when its holder generated no usage that month. New columns `active_seat_holders` and `active_users_without_seat`; `over_subscribed` now means someone used the provider without a seat. A test reproduces the two-holders, two-users case. |
| A month appeared only if it had usage or a seat started in it, so a seat paid for since July with no later usage vanished from August on, hiding exactly the waste the report is for. | Every month a seat is active, up to the current month, gets a row. A test checks July to September all appear and October does not once the seat ends. |
| The DB test harness truncated an existing schema without applying new migrations, so a local run could test a stale view and pass. CI always starts empty, so CI was unaffected. | The harness applies pending migrations whenever this project's runner owns the schema; a Supabase-applied schema is left to Supabase. |

| Model prices matched by prefix, so an unlisted `gpt-5-nano` was priced as `gpt-5` and `claude-opus-5-5-fast` as Opus, defeating the "unknown model fails" rule. | `findPrice` accepts an exact id, or a listed id plus a date suffix (`-20260601`, `-2026-06-01`) and nothing else; an exact key wins over a family key. Tests cover the sibling cases and that the import refuses them. |

| (found while checking CI for the above) The Supabase job installed CLI `latest`, which moved to 3.0.0 and rejects the `[inbucket]` config section, so the job failed on code that had not changed. | Config uses `[local_smtp]` (accepted by v2 and v3, checked locally against both); the CLI is pinned to 2.122.1 and is bumped deliberately. |

The shared fixture was itself the bug case: the one OpenAI seat is Alice's
but Carol did the work. The old test asserted "not over-subscribed"; it is
now one idle seat and one user without a seat.

## What was not done, on purpose

- No reconciliation against a real provider invoice. The README says so.
- No scheduled provider sync, live spend enforcement, alerts or dashboard.
  It is an internal reporting tool.
- The Mac mini throughput, KV-cache size and GBP/USD figures in the example
  are labelled placeholders until measured on the actual machine.

After commit 8 the reviewer's advice was to verify, measure and stop adding
features. That is the plan.
