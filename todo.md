# Tech debt

Known issues from the independent code scan of 3 November 2026, not yet
fixed. Each entry says what is wrong, how it shows up, and the intended fix.
The scan's other findings were fixed at the time and are recorded in
`docs/review-log.md`.

## 1. Usage rows are unique per provider, not per team

**Severity:** medium. **Where:** `supabase/migrations/20261016000100_core_schema.sql`,
`unique (provider, external_id)` on `usage_events`; `src/importers/index.ts`
(`CrossTeamConflictError`).

**Problem.** The row key is global across teams, so one team's rows can
collide with another's:

- *Existence probe.* Any signed-up user can create a team and insert into
  `usage_events` for it through the API. Inserting another team's
  `external_id` raises a unique violation, which tells them that row exists.
  Row-level security still stops them reading it.
- *Import blocking.* `external_id` is a hash of the bucket times, model and
  grouping fields. For an export not grouped by API key it is predictable,
  so pre-inserting it makes the victim team's next server-side import fail
  with `CrossTeamConflictError`.
- *Accidental collision (not reproduced).* Two teams on separate provider
  organisations importing ungrouped exports for the same day and model get
  the same `external_id`, because the provider organisation is not part of
  the hash.

**Fix.** New migration: make the key `unique (team_id, provider, external_id)`
and change the upsert's `on conflict` target to match. The cross-team check
in `upsertUsage` then becomes unnecessary and can go. Optionally add the
provider organisation or workspace id to `stableId`. Tests: a team-B user
inserting team A's `external_id` succeeds as a separate row and learns
nothing; team A's import still succeeds afterwards.

## 2. Runtime dependency advisories

**Severity:** medium (zod), low (csv-parse). **Where:** `package.json`.

- **zod 3.25.76**: high advisory, memory exhaustion while validating
  oversized constrained collections. The importers validate provider
  exports with zod, so a hostile or corrupt export file is the exposure.
  Fixed only in zod 4 (>= 4.6.6), which is a major upgrade with API changes
  to check across `src/importers/*.ts`, `src/pricing.ts` and
  `src/alternatives.ts`.
- **csv-parse 5.6.0**: moderate advisory (prototype replacement). Nothing in
  the repository imports it. Remove it from `dependencies`.

**Fix.** Remove csv-parse; upgrade zod to 4 and run the full suite (unit and
DB). Confirm with `pnpm audit --prod`, which should then report nothing.

Separately, `pnpm audit` without `--prod` reports three critical advisories
from vitest 2 and its bundled vite. They are dev-only and exploitable only
while a vitest UI or dev server is running, but they are the first thing
anyone running `pnpm audit` sees. Upgrading vitest clears them.

## 3. Dev-only minimatch advisory through eslint 9

**Severity:** low (moderate advisory, dev-only). **Where:** `package.json`,
`eslint` 9.39.5 in `devDependencies`.

**Problem.** eslint 9 and `@eslint/config-array` pull in minimatch 3.1.5,
which has a moderate advisory (denial of service through globparts
amplification, fixed in minimatch >= 11.0.1). It is reachable only while
eslint matches file patterns in this repository, so the exposure is a slow
or hung lint run, not anything in the shipped code. Found by the monthly
health check of 3 November 2026. The vitest upgrade in item 2 does not
clear it.

**Fix.** Upgrade eslint to 10 (a major version; check `eslint.config.*` and
`typescript-eslint` compatibility), then confirm `pnpm lint` passes and
`pnpm audit` no longer lists minimatch.
