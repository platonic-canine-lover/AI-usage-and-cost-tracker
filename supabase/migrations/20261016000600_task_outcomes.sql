-- Task outcomes: the human side of the cloud-vs-local question.
--
-- Machine time and token cost say what a run costs to produce. This table
-- records what it cost to make the result usable: how long someone spent
-- reviewing or correcting it, how many retries it took, and whether it was
-- accepted. One row per task attempt, recorded by hand or by a script, for a
-- cloud model (provider + model) or a local one (provider 'local' + the
-- alternatives-file model id).
--
-- Kept deliberately separate from usage_events: those are provider facts,
-- these are judgements.

alter type public.provider add value if not exists 'local';

create table public.task_outcomes (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams (id) on delete cascade,
  user_id         uuid,
  provider        public.provider not null,
  model           text not null,
  task            text not null check (length(task) between 1 and 200),
  review_minutes  numeric(8,2) not null check (review_minutes >= 0),
  retries         int not null default 0 check (retries >= 0),
  accepted        boolean not null,
  note            text,
  recorded_at     timestamptz not null default now()
);
create index task_outcomes_team_model_idx on public.task_outcomes (team_id, provider, model, recorded_at desc);

alter table public.task_outcomes enable row level security;
alter table public.task_outcomes force row level security;
grant select, insert, update, delete on public.task_outcomes to authenticated, service_role;

create policy task_outcomes_select on public.task_outcomes
  for select to authenticated using (public.is_team_member(team_id));
create policy task_outcomes_insert on public.task_outcomes
  for insert to authenticated with check (public.is_team_member(team_id));
create policy task_outcomes_modify on public.task_outcomes
  for update to authenticated using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy task_outcomes_delete on public.task_outcomes
  for delete to authenticated using (public.is_team_admin(team_id));

-- Per team, provider and model: how much human time a result costs on average,
-- and how often it was accepted. The local report joins this to put a human
-- figure beside the machine figure.
create view public.task_quality
with (security_invoker = true) as
select
  team_id,
  provider,
  model,
  count(*)::int                                            as attempts,
  count(*) filter (where accepted)::int                    as accepted,
  round(avg(review_minutes), 2)                            as avg_review_minutes,
  round(avg(retries), 2)                                   as avg_retries,
  round(count(*) filter (where accepted)::numeric / count(*), 3) as acceptance_rate
from public.task_outcomes
group by team_id, provider, model;

grant select on public.task_quality to authenticated, service_role;
