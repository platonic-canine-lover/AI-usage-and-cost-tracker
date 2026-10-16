-- Report views. All are security_invoker so RLS on the underlying tables
-- still applies when a team member queries them through the API.

-- Spend per team per ISO week (Monday start), against the team's weekly cap.
create view public.weekly_spend
with (security_invoker = true) as
select
  u.team_id,
  date_trunc('week', u.occurred_at at time zone 'UTC')::date as week_start,
  sum(u.cost_micro_usd)::bigint                                as spend_micro_usd,
  b.weekly_cap_micro_usd,
  b.weekly_cap_micro_usd is not null
    and sum(u.cost_micro_usd) > b.weekly_cap_micro_usd         as over_cap,
  count(*)::bigint                                             as event_count
from public.usage_events u
left join public.budgets b on b.team_id = u.team_id
group by u.team_id, week_start, b.weekly_cap_micro_usd;

-- Seat use per team, provider and calendar month: paid seats vs people who
-- actually generated usage, and what each active seat cost in usage terms.
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
         count(s.id)::int                          as paid_seats,
         coalesce(sum(s.monthly_cost_micro_usd), 0)::bigint as seat_cost_micro_usd
  from months m
  left join public.seats s
    on s.team_id = m.team_id
   and s.provider = m.provider
   and s.active_from <= (m.month_start + interval '1 month' - interval '1 day')::date
   and (s.active_to is null or s.active_to >= m.month_start)
  group by m.team_id, m.provider, m.month_start
),
active as (
  select team_id, provider,
         date_trunc('month', occurred_at at time zone 'UTC')::date as month_start,
         count(distinct user_id)::int                              as active_users,
         sum(cost_micro_usd)::bigint                               as usage_cost_micro_usd
  from public.usage_events
  where user_id is not null
  group by team_id, provider, month_start
)
select
  p.team_id,
  p.provider,
  p.month_start,
  p.paid_seats,
  coalesce(a.active_users, 0)                          as active_users,
  greatest(p.paid_seats - coalesce(a.active_users, 0), 0) as idle_seats,
  p.seat_cost_micro_usd,
  coalesce(a.usage_cost_micro_usd, 0)                  as usage_cost_micro_usd
from paid p
left join active a
  on a.team_id = p.team_id and a.provider = p.provider and a.month_start = p.month_start;

grant select on public.weekly_spend, public.seat_use to authenticated, service_role;
