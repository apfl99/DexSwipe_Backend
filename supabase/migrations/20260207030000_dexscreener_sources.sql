-- Additional DexScreener sources:
-- - /token-boosts/latest/v1
-- - /community-takeovers/latest/v1
-- - /tokens/v1/{chainId}/{tokenAddresses}

-- Extend runs table to track source
alter table public.dexscreener_ingestion_runs
  add column if not exists source text,
  add column if not exists endpoint text;

-- Boosted tokens (latest)
create table if not exists public.dexscreener_token_boosts_raw (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  amount numeric,
  total_amount numeric,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_id uuid,
  primary key (chain_id, token_address)
);

create index if not exists idx_dexscreener_boosts_fetched_at
  on public.dexscreener_token_boosts_raw (fetched_at desc);

-- Community takeovers (latest)
create table if not exists public.dexscreener_community_takeovers_raw (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  claim_date timestamptz,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_id uuid,
  primary key (chain_id, token_address)
);

create index if not exists idx_dexscreener_takeovers_claim_date
  on public.dexscreener_community_takeovers_raw (claim_date desc nulls last);

-- Token pairs/market snapshots (raw pairs from /tokens/v1)
create table if not exists public.dexscreener_pairs_raw (
  chain_id text not null,
  pair_address text not null,
  base_token_address text,
  quote_token_address text,
  raw jsonb not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_id uuid,
  primary key (chain_id, pair_address)
);

create index if not exists idx_dexscreener_pairs_base_token
  on public.dexscreener_pairs_raw (chain_id, base_token_address);
create index if not exists idx_dexscreener_pairs_quote_token
  on public.dexscreener_pairs_raw (chain_id, quote_token_address);
create index if not exists idx_dexscreener_pairs_fetched_at
  on public.dexscreener_pairs_raw (fetched_at desc);

-- Keep these tables private by default
alter table public.dexscreener_token_boosts_raw enable row level security;
alter table public.dexscreener_community_takeovers_raw enable row level security;
alter table public.dexscreener_pairs_raw enable row level security;

