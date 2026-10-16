-- Workload attestations.
--
-- The combined cost-per-accepted-result divides a month's cloud spend by the
-- task outcomes recorded for that month. That is only fair if those records
-- are the whole workload the spend paid for, and nothing in the data can
-- prove that. So it is attested explicitly, per team, provider, model and
-- month, by whoever knows; without the attestation the combined figure is
-- suppressed and the report says why.

create table public.workload_attestations (
  team_id      uuid not null references public.teams (id) on delete cascade,
  provider     public.provider not null,
  model        text not null,
  month_start  date not null check (month_start = date_trunc('month', month_start)::date),
  complete     boolean not null,
  note         text,
  attested_by  uuid,
  attested_at  timestamptz not null default now(),
  primary key (team_id, provider, model, month_start)
);

alter table public.workload_attestations enable row level security;
alter table public.workload_attestations force row level security;
grant select, insert, update, delete on public.workload_attestations to authenticated, service_role;

create policy workload_attestations_select on public.workload_attestations
  for select to authenticated using (public.is_team_member(team_id));
create policy workload_attestations_write on public.workload_attestations
  for all to authenticated using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
