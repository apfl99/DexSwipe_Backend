-- DexScreener market ingestion using /tokens/v1/{chainId}/{tokenAddresses} (up to 30 addresses)
-- Rate-limit per DexScreener docs: 300 requests per minute
-- Ref: https://docs.dexscreener.com/api/reference

create table if not exists public.dexscreener_market_update_queue (
  chain_id text not null,
  token_address text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  updated_at timestamptz not null default now(),
  last_error text,
  last_fetched_at timestamptz,
  primary key (chain_id, token_address)
);

create index if not exists idx_market_queue_next_run
  on public.dexscreener_market_update_queue (status, next_run_at);

create table if not exists public.dexscreener_token_market_data (
  chain_id text not null,
  token_address text not null,
  best_pair_address text,
  raw_best_pair jsonb not null,
  price_usd numeric,
  liquidity_usd numeric,
  volume_24h numeric,
  fdv numeric,
  market_cap numeric,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, token_address)
);

create index if not exists idx_token_market_updated_at
  on public.dexscreener_token_market_data (updated_at desc);
create index if not exists idx_token_market_liquidity
  on public.dexscreener_token_market_data (liquidity_usd desc nulls last);
create index if not exists idx_token_market_volume
  on public.dexscreener_token_market_data (volume_24h desc nulls last);

alter table public.dexscreener_market_update_queue enable row level security;
alter table public.dexscreener_token_market_data enable row level security;

-- Dequeue market jobs (allow periodic refresh via next_run_at)
create or replace function public.dequeue_market_updates(batch_size integer default 60)
returns table(chain_id text, token_address text, attempts integer)
language sql
security definer
as $$
  with picked as (
    select q.chain_id, q.token_address
    from public.dexscreener_market_update_queue q
    where q.status in ('pending', 'failed', 'completed')
      and q.next_run_at <= now()
    order by q.next_run_at asc
    limit batch_size
    for update skip locked
  )
  update public.dexscreener_market_update_queue q
  set status = 'processing',
      locked_at = now(),
      updated_at = now(),
      last_error = null
  from picked
  where q.chain_id = picked.chain_id
    and q.token_address = picked.token_address
  returning q.chain_id, q.token_address, q.attempts;
$$;

-- Schedule market worker every 10 minutes (uses Vault secrets)
select
  cron.schedule(
    'dexscreener_market_every_10m',
    '*/10 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/fetch-dexscreener-market',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

