-- GoPlus Token Security integration (queue + cache + worker schedule)

-- Chain mapping between DexScreener chainId (string) and GoPlus identifiers.
create table if not exists public.chain_mappings (
  dexscreener_chain_id text primary key,
  goplus_mode text not null check (goplus_mode in ('evm', 'solana')),
  goplus_chain_id text
);

insert into public.chain_mappings (dexscreener_chain_id, goplus_mode, goplus_chain_id)
values
  ('base', 'evm', '8453'),
  ('solana', 'solana', null)
on conflict (dexscreener_chain_id) do nothing;

-- Queue table (deduped by PK) for token security scans.
create table if not exists public.token_security_scan_queue (
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

create index if not exists idx_token_security_scan_queue_next_run
  on public.token_security_scan_queue (status, next_run_at);

-- Cache: keep full raw response + extracted fields for filtering.
create table if not exists public.goplus_token_security_cache (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  scanned_at timestamptz not null default now(),

  -- extracted (best-effort, field names depend on chain)
  cannot_sell boolean,
  is_honeypot boolean,
  is_proxy boolean,
  contract_upgradeable boolean,
  buy_tax numeric,
  sell_tax numeric,

  -- policy
  always_deny boolean not null default false,
  deny_reasons text[] not null default '{}'::text[],

  -- optional: normalized score (0..100)
  trust_score integer,

  primary key (chain_id, token_address)
);

create index if not exists idx_goplus_cache_scanned_at
  on public.goplus_token_security_cache (scanned_at desc);

-- Keep internal tables private by default
alter table public.chain_mappings enable row level security;
alter table public.token_security_scan_queue enable row level security;
alter table public.goplus_token_security_cache enable row level security;

-- Dequeue jobs atomically for worker(s)
create or replace function public.dequeue_token_security_scans(batch_size integer default 20)
returns table(chain_id text, token_address text, attempts integer)
language sql
security definer
as $$
  with picked as (
    select q.chain_id, q.token_address
    from public.token_security_scan_queue q
    where q.status in ('pending', 'failed')
      and q.next_run_at <= now()
    order by q.next_run_at asc
    limit batch_size
    for update skip locked
  )
  update public.token_security_scan_queue q
  set status = 'processing',
      locked_at = now(),
      updated_at = now(),
      last_error = null
  from picked
  where q.chain_id = picked.chain_id
    and q.token_address = picked.token_address
  returning q.chain_id, q.token_address, q.attempts;
$$;

-- Schedule worker every 5 minutes (Vault secrets required: project_url, dexswipe_cron_secret)
select
  cron.schedule(
    'goplus_security_worker_every_5m',
    '*/5 * * * *',
    $$
    select
      net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
              || '/functions/v1/goplus-security-worker',
        headers := jsonb_build_object(
          'Content-type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
    $$
  );

