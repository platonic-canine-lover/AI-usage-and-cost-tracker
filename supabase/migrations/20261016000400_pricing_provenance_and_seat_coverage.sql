-- Review follow-ups.
--
-- 1. Pricing provenance: every imported row records which price list priced it.
-- 2. Seat-use honesty: the report now exposes how much usage could not be
--    attributed to a person (unmapped principals), and flags months where more
--    people were active than seats were paid for, instead of clamping to zero
--    and hiding both.

alter table public.usage_events
  add column pricing_version text;

comment on column public.usage_events.pricing_version is
  'Version of the pricing table that produced cost_micro_usd (from the pricing file, or a content hash).';

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
paid as (
  select m.team_id, m.provider, m.month_start,
         count(s.id)::int                                    as paid_seats,
         coalesce(sum(s.monthly_cost_micro_usd), 0)::bigint  as seat_cost_micro_usd
  from months m
  left join public.seats s
    on s.team_id = m.team_id
   and s.provider = m.provider
   and s.active_from <= (m.month_start + interval '1 month' - interval '1 day')::date
   and (s.active_to is null or s.active_to >= m.month_start)
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
  p.seat_cost_micro_usd,
  coalesce(u.attributed_cost_micro_usd, 0) + coalesce(u.unattributed_cost_micro_usd, 0) as usage_cost_micro_usd,
  coalesce(u.unattributed_cost_micro_usd, 0)                       as unattributed_cost_micro_usd,
  case when coalesce(u.events, 0) = 0 then 1.0
       else round(1.0 - coalesce(u.unattributed_events, 0)::numeric / u.events, 3) end as attribution_coverage
from paid p
left join usage u
  on u.team_id = p.team_id and u.provider = p.provider and u.month_start = p.month_start;

grant select on public.seat_use to authenticated, service_role;
