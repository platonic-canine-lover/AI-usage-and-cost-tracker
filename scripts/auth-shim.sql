-- Minimal stand-in for the parts of Supabase the migrations depend on, so the
-- same migration files run on plain Postgres (CI matrix, local dev without Docker).
--
-- On a real Supabase database every step is skipped: the roles, the auth
-- schema and auth.uid() already exist and are owned by Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;

  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
    grant usage on schema auth to anon, authenticated, service_role;
  end if;

  -- PostgREST (and so Supabase) exposes the caller's JWT as request.jwt.claims;
  -- auth.uid() reads the `sub` claim. Same definition Supabase ships.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    create function auth.uid()
    returns uuid
    language sql
    stable
    as $fn$
      select nullif(
        coalesce(
          current_setting('request.jwt.claim.sub', true),
          (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
        ),
        ''
      )::uuid
    $fn$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  end if;
end $$;
