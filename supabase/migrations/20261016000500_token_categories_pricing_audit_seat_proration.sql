-- Second review follow-ups.
--
-- 1. Token categories are stored separately because each is billed at a
--    different rate: cache writes were previously folded into input_tokens.
-- 2. Pricing audit: usage_events records the content hash of the pricing file
--    as well as its label, and pricing_snapshots keeps the full configuration
--    per hash, so figures stay reproducible even if a label is reused.
-- 3. Seat cost semantics: seat_use now gives both the full monthly licence
--    cost (every seat active at any point in the month) and a day-prorated
--    estimate. Neither is a reconciled invoice figure; the column names say so.

alter table public.usage_events
  add column cache_write_tokens          bigint not null default 0 check (cache_write_tokens >= 0),
  add column cache_write_extended_tokens bigint not null default 0 check (cache_write_extended_tokens >= 0),
  add column pricing_hash                text;

comment on column public.usage_events.input_tokens is 'Uncached input tokens only; cache writes and reads have their own columns.';
comment on column public.usage_events.cache_write_tokens is 'Short-lived cache writes (Anthropic ephemeral 5m, OpenAI cache write).';
comment on column public.usage_events.cache_write_extended_tokens is 'Longer-lived cache writes (Anthropic ephemeral 1h, OpenAI 12h).';
comment on column public.usage_events.cached_tokens is 'Cache-read tokens.';
comment on column public.usage_events.pricing_hash is 'sha256 of the pricing file that produced cost_micro_usd; joins to pricing_snapshots.';

create table public.pricing_snapshots (
  hash        text primary key,
  version     text not null,
  config      jsonb not null,
  first_seen  timestamptz not null default now()
);
comment on table public.pricing_snapshots is 'Every pricing configuration ever used to price a row, keyed by content hash. Append-only.';

-- Snapshots carry no tenant data; any signed-in user may read them so a
-- report can show which prices were used. Only the server writes them.
alter table public.pricing_snapshots enable row level security;
alter table public.pricing_snapshots force row level security;
grant select on public.pricing_snapshots to authenticated, service_role;
grant insert on public.pricing_snapshots to service_role;
create policy pricing_snapshots_select on public.pricing_snapshots for select to authenticated using (true);

drop view public.seat_use;

create view public.seat_use
with (security_invoker = true) as
with months as (
  select distinct
    team_id,
    provider,
    date_trunc('month', occurred_at at time zone 'UTC')::date as month_start
  from public.usage_events
  union
  select distinct
    team_id,
    provider,
    date_trunc('month', active_from)::date
  from public.seats
),
seat_months as (
  select m.team_id, m.provider, m.month_start,
         s.id as seat_id,
         s.monthly_cost_micro_usd,
         -- days of the month the seat was active, for the prorated estimate
         (least(coalesce(s.active_to, 'infinity'::date), (m.month_start + interval '1 month' - interval '1 day')::date)
            - greatest(s.active_from, m.month_start) + 1)                                     as active_days,
         extract(day from (m.month_start + interval '1 month' - interval '1 day'))::int       as days_in_month
  from months m
  join public.seats s
    on s.team_id = m.team_id
   and s.provider = m.provider
   and s.active_from <= (m.month_start + interval '1 month' - interval '1 day')::date
   and (s.active_to is null or s.active_to >= m.month_start)
),
paid as (
  select m.team_id, m.provider, m.month_start,
         count(sm.seat_id)::int                                                               as paid_seats,
         coalesce(sum(sm.monthly_cost_micro_usd), 0)::bigint                                 as seat_cost_full_month_micro_usd,
         coalesce(sum(round(sm.monthly_cost_micro_usd::numeric * sm.active_days / sm.days_in_month)), 0)::bigint
                                                                                             as seat_cost_prorated_micro_usd
  from months m
  left join seat_months sm
    on sm.team_id = m.team_id and sm.provider = m.provider and sm.month_start = m.month_start
  group by m.team_id, m.provider, m.month_start
),
usage as (
  select team_id, provider,
         date_trunc('month', occurred_at at time zone 'UTC')::date          as month_start,
         count(distinct user_id)::int                                        as active_users,
         sum(cost_micro_usd) filter (where user_id is not null)::bigint      as attributed_cost_micro_usd,
         sum(cost_micro_usd) filter (where user_id is null)::bigint          as unattributed_cost_micro_usd,
         count(*) filter (where user_id is null)::int                        as unattributed_events,
         count(*)::int                                                       as events
  from public.usage_events
  group by team_id, provider, month_start
)
select
  p.team_id,
  p.provider,
  p.month_start,
  p.paid_seats,
  coalesce(u.active_users, 0)                                      as active_users,
  greatest(p.paid_seats - coalesce(u.active_users, 0), 0)          as idle_seats,
  coalesce(u.active_users, 0) > p.paid_seats                       as over_subscribed,
  p.seat_cost_full_month_micro_usd,
  p.seat_cost_prorated_micro_usd,
  coalesce(u.attributed_cost_micro_usd, 0) + coalesce(u.unattributed_cost_micro_usd, 0) as usage_cost_micro_usd,
  coalesce(u.unattributed_cost_micro_usd, 0)                       as unattributed_cost_micro_usd,
  case when coalesce(u.events, 0) = 0 then 1.0
       else round(1.0 - coalesce(u.unattributed_events, 0)::numeric / u.events, 3) end as attribution_coverage
from paid p
left join usage u
  on u.team_id = p.team_id and u.provider = p.provider and u.month_start = p.month_start;

grant select on public.seat_use to authenticated, service_role;
