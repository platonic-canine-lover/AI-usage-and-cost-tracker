-- Seat use, counted per seat.
--
-- The previous view had two faults, both of which hid wasted seats:
--
-- 1. idle_seats was paid_seats minus the number of people with usage, whether
--    or not those people held a seat. Two seat holders who never used the
--    provider, plus two people without seats who did, reported 0 idle seats.
--    Now a seat is idle when ITS HOLDER generated no usage that month, and
--    people who used the provider without a seat are counted separately.
--
-- 2. A month only appeared if it had usage, or a seat started in it. A seat
--    paid for since July with no usage since showed July and then vanished,
--    which is exactly the month-on-month waste the report exists to show.
--    Now every month a seat is active up to the current month gets a row.

drop view public.seat_use;

create view public.seat_use
with (security_invoker = true) as
with seat_month_starts as (
  -- every calendar month each seat was active, up to and including the current month
  select s.team_id, s.provider, gs::date as month_start
  from public.seats s
  cross join lateral generate_series(
    date_trunc('month', s.active_from),
    date_trunc('month', least(coalesce(s.active_to, (now() at time zone 'UTC')::date), (now() at time zone 'UTC')::date)),
    interval '1 month'
  ) as gs
),
months as (
  select team_id, provider, month_start from seat_month_starts
  union
  select team_id, provider, date_trunc('month', occurred_at at time zone 'UTC')::date
  from public.usage_events
),
seat_months as (
  select m.team_id, m.provider, m.month_start,
         s.id as seat_id,
         s.user_id,
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
month_users as (
  -- who generated attributed usage, per team, provider and month
  select distinct team_id, provider,
         date_trunc('month', occurred_at at time zone 'UTC')::date as month_start,
         user_id
  from public.usage_events
  where user_id is not null
),
paid as (
  select m.team_id, m.provider, m.month_start,
         count(sm.seat_id)::int                                                               as paid_seats,
         count(sm.seat_id) filter (where mu.user_id is not null)::int                         as active_seat_holders,
         coalesce(sum(sm.monthly_cost_micro_usd), 0)::bigint                                 as seat_cost_full_month_micro_usd,
         coalesce(sum(round(sm.monthly_cost_micro_usd::numeric * sm.active_days / sm.days_in_month)), 0)::bigint
                                                                                             as seat_cost_prorated_micro_usd
  from months m
  left join seat_months sm
    on sm.team_id = m.team_id and sm.provider = m.provider and sm.month_start = m.month_start
  left join month_users mu
    on mu.team_id = sm.team_id and mu.provider = sm.provider and mu.month_start = sm.month_start and mu.user_id = sm.user_id
  group by m.team_id, m.provider, m.month_start
),
unseated as (
  -- people who used the provider in a month without holding an active seat for it
  select mu.team_id, mu.provider, mu.month_start, count(*)::int as active_users_without_seat
  from month_users mu
  where not exists (
    select 1 from seat_months sm
    where sm.team_id = mu.team_id and sm.provider = mu.provider and sm.month_start = mu.month_start and sm.user_id = mu.user_id
  )
  group by mu.team_id, mu.provider, mu.month_start
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
  p.active_seat_holders,
  p.paid_seats - p.active_seat_holders                             as idle_seats,
  coalesce(us.active_users_without_seat, 0)                        as active_users_without_seat,
  coalesce(us.active_users_without_seat, 0) > 0                    as over_subscribed,
  p.seat_cost_full_month_micro_usd,
  p.seat_cost_prorated_micro_usd,
  coalesce(u.attributed_cost_micro_usd, 0) + coalesce(u.unattributed_cost_micro_usd, 0) as usage_cost_micro_usd,
  coalesce(u.unattributed_cost_micro_usd, 0)                       as unattributed_cost_micro_usd,
  case when coalesce(u.events, 0) = 0 then 1.0
       else round(1.0 - coalesce(u.unattributed_events, 0)::numeric / u.events, 3) end as attribution_coverage
from paid p
left join usage u
  on u.team_id = p.team_id and u.provider = p.provider and u.month_start = p.month_start
left join unseated us
  on us.team_id = p.team_id and us.provider = p.provider and us.month_start = p.month_start;

comment on view public.seat_use is
  'Per team, provider and month: paid seats, which seat holders used the provider, idle seats (holder had no usage), people who used it without a seat, seat cost estimates and attribution coverage. Every month a seat is active appears, with or without usage. Unattributed usage (no user mapping) cannot make a seat active.';

grant select on public.seat_use to authenticated, service_role;
