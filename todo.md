# Tech debt

Known issues, not yet fixed. Items 1 to 3 come from the independent code scan
of 3 November 2026; items 4 to 6 from reading the access policies while
writing the cross-user security test on 12 November 2026. Each entry says
what is wrong, how it shows up, and the intended fix. The scan's other
findings were fixed at the time and are recorded in `docs/review-log.md`.

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

## 4. An admin can demote or remove the team's owner

**Severity:** medium. **Where:** `supabase/migrations/20261016000200_row_level_security.sql`,
`is_team_admin` and the `team_members_update` and `team_members_delete`
policies.

**Problem.** `is_team_admin` is true for both `owner` and `admin`, and the
membership policies check nothing else. So an admin can set the owner's role
to `member`, delete the owner's membership, or make themselves `owner`. The
same policies let the last owner leave or be removed, which leaves a team
that nobody owns. The `owner` role therefore carries no protection that
`admin` lacks. Not reproduced in a test: it follows from the policy text.

**Fix.** New migration. Only an owner may insert, update or delete a
membership row whose role is `owner` (old or new value), and an admin may
not set any role to `owner`. Add a trigger that refuses to remove or demote
a team's last owner. Tests in `test/db/rls.cross-user.test.ts`: an admin's
update and delete against the owner affect zero rows; an admin cannot
promote themselves; the last owner cannot leave.

## 5. A member can record a task outcome under a team-mate's user id

**Severity:** low. **Where:** `supabase/migrations/20261016000600_task_outcomes.sql`,
`task_outcomes_insert`.

**Problem.** The insert policy checks only that the caller belongs to the
team. `user_id` is whatever the caller sends, so a plain member can file a
rejected or slow outcome against a colleague's name, or an accepted one
against their own model of choice under someone else's. Outcomes feed the
`task_quality` view and the cost-per-accepted-result line, where a person's
review time is priced. The row stays inside the team, so nothing leaks; the
record is simply not trustworthy as to who made it. Not reproduced in a test.

**Fix.** New migration: the insert policy also requires
`user_id = auth.uid()`, or `user_id is null`, unless the caller is an admin
(admins and the server-side script record on behalf of others). Consider
defaulting `user_id` to `auth.uid()`. Test: a member inserting with a
team-mate's id is refused; with their own id it succeeds.

## 6. A team's creator still sees the team after being removed from it

**Severity:** low. **Where:** `supabase/migrations/20261016000200_row_level_security.sql`,
`teams_select`.

**Problem.** The policy is `is_team_member(id) or created_by = auth.uid()`.
The second half is there so that `insert ... returning` works before the
trigger has added the creator as owner, but it never expires. A creator who
has left or been removed can still read the team's row: its id, name and
creation date. They can read none of its members, spend, seats or budget.
Not reproduced in a test.

**Fix.** Drop the `created_by` clause and make team creation not depend on
it: either add the creator's membership in a `before insert` step so
`is_team_member` is already true when `returning` is evaluated, or create
teams through a `security definer` function that returns the new id. Test:
after the creator's membership is deleted, `select from teams` returns
nothing for them, and `createTeam` in the harness still returns the id.
