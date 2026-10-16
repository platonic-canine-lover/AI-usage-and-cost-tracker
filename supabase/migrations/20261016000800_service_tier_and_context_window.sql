-- Pricing is a function of (model, context bucket, service tier), not of the
-- model alone: long prompts are billed at a higher rate and batch requests at
-- a discount. The importer already read both fields from the usage export
-- and used them only in the row id; now they are stored and priced, and a
-- row whose figure is known to be approximate says why.

alter table public.usage_events
  add column service_tier   text,
  add column context_window text,
  add column pricing_note   text;

comment on column public.usage_events.service_tier is
  'Provider service tier as exported (standard, batch, priority, flex, ...). Null when the export was not grouped by it.';
comment on column public.usage_events.context_window is
  'Provider context-window bucket as exported (Anthropic: 0-200k, 200k-1M). Null when not grouped by it or not reported.';
comment on column public.usage_events.pricing_note is
  'Null when cost_micro_usd should match the invoice. Otherwise why it may not: an ungrouped export priced at the base rate, or a context bucket that straddles the model''s price break.';

create index usage_events_pricing_note_idx on public.usage_events (team_id) where pricing_note is not null;
