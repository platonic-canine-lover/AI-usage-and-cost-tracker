-- Row-level security: every tenant table is scoped to the caller's teams.
--
-- The policies use two helpers that read team_members as SECURITY DEFINER so
-- the team_members policy does not recurse into itself. Both are STABLE so the
-- planner can cache them per statement.

create or replace function public.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_team_admin(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_team_member(uuid) from public;
revoke all on function public.is_team_admin(uuid) from public;
grant execute on function public.is_team_member(uuid) to authenticated, service_role;
grant execute on function public.is_team_admin(uuid) to authenticated, service_role;

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.seats        enable row level security;
alter table public.usage_events enable row level security;
alter table public.budgets      enable row level security;

-- Belt and braces: RLS also applies to the table owner.
alter table public.teams        force row level security;
alter table public.team_members force row level security;
alter table public.seats        force row level security;
alter table public.usage_events force row level security;
alter table public.budgets      force row level security;

-- Grants mirror Supabase defaults: anon sees nothing, authenticated goes
-- through policies, service_role (server-side importers/reports) bypasses RLS.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage on all sequences in schema public to authenticated, service_role;

-- teams ---------------------------------------------------------------------
-- created_by is included so INSERT ... RETURNING works for the creator before
-- the AFTER INSERT trigger below has added them to team_members.
create policy teams_select on public.teams
  for select to authenticated
  using (public.is_team_member(id) or created_by = auth.uid());

-- Anyone signed in can create a team, but only as themselves.
create policy teams_insert on public.teams
  for insert to authenticated
  with check (created_by = auth.uid());

create policy teams_update on public.teams
  for update to authenticated
  using (public.is_team_admin(id))
  with check (public.is_team_admin(id));

create policy teams_delete on public.teams
  for delete to authenticated
  using (public.is_team_admin(id));

create or replace function public.add_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into public.team_members (team_id, user_id, role)
    values (new.id, auth.uid(), 'owner');
  end if;
  return new;
end;
$$;

create trigger teams_add_creator_as_owner
  after insert on public.teams
  for each row execute function public.add_creator_as_owner();

-- team_members --------------------------------------------------------------
create policy team_members_select on public.team_members
  for select to authenticated
  using (public.is_team_member(team_id));

create policy team_members_insert on public.team_members
  for insert to authenticated
  with check (public.is_team_admin(team_id));

create policy team_members_update on public.team_members
  for update to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));

create policy team_members_delete on public.team_members
  for delete to authenticated
  using (public.is_team_admin(team_id) or user_id = auth.uid());

-- usage_events --------------------------------------------------------------
create policy usage_events_select on public.usage_events
  for select to authenticated
  using (public.is_team_member(team_id));

create policy usage_events_write on public.usage_events
  for all to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));

-- seats ---------------------------------------------------------------------
create policy seats_select on public.seats
  for select to authenticated
  using (public.is_team_member(team_id));

create policy seats_write on public.seats
  for all to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));

-- budgets -------------------------------------------------------------------
create policy budgets_select on public.budgets
  for select to authenticated
  using (public.is_team_member(team_id));

create policy budgets_write on public.budgets
  for all to authenticated
  using (public.is_team_admin(team_id))
  with check (public.is_team_admin(team_id));
