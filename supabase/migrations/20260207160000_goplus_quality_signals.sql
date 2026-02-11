-- GoPlus quality signals (free-tier friendly):
-- - phishing_site(url)
-- - dapp_security(url)
-- - rugpull_detecting(chain_id) for EVM tokens
-- Cached + queued + scheduled to avoid excessive calls.
-- Ref: https://docs.gopluslabs.io/reference/api-overview

create table if not exists public.token_quality_scan_queue (
  chain_id text not null,
  token_address text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  updated_at timestamptz not null default now(),
  last_error text,
  last_scanned_at timestamptz,
  primary key (chain_id, token_address)
);

create index if not exists idx_quality_queue_next_run
  on public.token_quality_scan_queue (status, next_run_at);

-- Cache: URL risks (phishing + dapp risk)
create table if not exists public.goplus_url_risk_cache (
  url text primary key,
  raw_phishing jsonb,
  raw_dapp jsonb,
  is_phishing boolean,
  dapp_risk_level text,
  scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_url_risk_scanned_at
  on public.goplus_url_risk_cache (scanned_at desc);

-- Cache: rug-pull detection for EVM tokens (chain-specific)
create table if not exists public.goplus_rugpull_cache (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  is_rugpull_risk boolean,
  risk_level text,
  scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, token_address)
);

alter table public.token_quality_scan_queue enable row level security;
alter table public.goplus_url_risk_cache enable row level security;
alter table public.goplus_rugpull_cache enable row level security;

create or replace function public.dequeue_token_quality_scans(batch_size integer default 20)
returns table(chain_id text, token_address text, attempts integer)
language sql
security definer
as $$
  with picked as (
    select q.chain_id, q.token_address
    from public.token_quality_scan_queue q
    where q.status in ('pending', 'failed', 'completed')
      and q.next_run_at <= now()
    order by q.next_run_at asc
    limit batch_size
    for update skip locked
  )
  update public.token_quality_scan_queue q
  set status = 'processing',
      locked_at = now(),
      updated_at = now(),
      last_error = null
  from picked
  where q.chain_id = picked.chain_id
    and q.token_address = picked.token_address
  returning q.chain_id, q.token_address, q.attempts;
$$;

-- Schedule quality worker (very low frequency; strong caching).
select
  cron.schedule(
    'goplus_quality_worker_every_2h',
    '0 */2 * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/goplus-quality-worker',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

