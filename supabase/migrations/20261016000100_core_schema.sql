-- Core schema: teams, membership, usage events, budgets and seats.
--
-- Conventions
--   * Money is stored in micro-USD (bigint, 1 USD = 1_000_000). Provider prices
--     go to fractions of a cent per token, so integer micro-dollars avoid float drift.
--   * Every tenant-owned row carries team_id. RLS (next migration) keys off it.
--   * auth.uid() is Supabase's current-user function. On plain Postgres the test
--     harness installs an equivalent shim (see scripts/auth-shim.sql).

create extension if not exists pgcrypto;

create type public.provider as enum ('anthropic', 'openai');
create type public.member_role as enum ('owner', 'admin', 'member');

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 120),
  created_by  uuid default auth.uid(),   -- null when created server-side (service_role)
  created_at  timestamptz not null default now()
);

create table public.team_members (
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null,
  role        public.member_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

-- A seat is a paid licence for a person on a team. Seat-use compares seats
-- against who actually generated usage.
create table public.seats (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams (id) on delete cascade,
  user_id         uuid not null,
  provider        public.provider not null,
  monthly_cost_micro_usd bigint not null check (monthly_cost_micro_usd >= 0),
  active_from     date not null default current_date,
  active_to       date,
  unique (team_id, user_id, provider)
);

-- One row per provider usage record (one API call, or one aggregated line
-- from a provider export). Idempotent on (provider, external_id).
create table public.usage_events (
  id                uuid primary key default gen_random_uuid(),
  team_id           uuid not null references public.teams (id) on delete cascade,
  user_id           uuid,
  provider          public.provider not null,
  model             text not null,
  external_id       text not null,
  input_tokens      bigint not null default 0 check (input_tokens >= 0),
  output_tokens     bigint not null default 0 check (output_tokens >= 0),
  cached_tokens     bigint not null default 0 check (cached_tokens >= 0),
  cost_micro_usd    bigint not null check (cost_micro_usd >= 0),
  occurred_at       timestamptz not null,
  imported_at       timestamptz not null default now(),
  unique (provider, external_id)
);
create index usage_events_team_time_idx on public.usage_events (team_id, occurred_at desc);
create index usage_events_team_user_idx on public.usage_events (team_id, user_id);

-- Weekly cap per team. Weeks start on Monday (ISO).
create table public.budgets (
  team_id               uuid primary key references public.teams (id) on delete cascade,
  weekly_cap_micro_usd  bigint not null check (weekly_cap_micro_usd > 0),
  updated_at            timestamptz not null default now()
);
