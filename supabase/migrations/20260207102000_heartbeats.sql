-- Heartbeats to verify scheduled execution without local calls

create table if not exists public.edge_function_heartbeats (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  ran_at timestamptz not null default now(),
  processed_count integer,
  note text
);

create index if not exists idx_edge_function_heartbeats_ran_at
  on public.edge_function_heartbeats (ran_at desc);

alter table public.edge_function_heartbeats enable row level security;

