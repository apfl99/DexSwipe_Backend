-- Quality improvements (release):
-- - Add boosts/top ingestion (more curated discovery)
-- - Reduce call frequency (still far below limits)
-- - Keep market + GoPlus as downstream enrichers
--
-- DexScreener reference: https://docs.dexscreener.com/api/reference

create table if not exists public.dexscreener_token_boosts_top_raw (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  amount integer,
  total_amount integer,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_id uuid,
  primary key (chain_id, token_address)
);

alter table public.dexscreener_token_boosts_top_raw enable row level security;

do $$
declare
  jid integer;
begin
  -- unschedule old jobs by name if they exist
  for jid in
    select jobid from cron.job
    where jobname in (
      'dexscreener_profiles_every_5m',
      'dexscreener_boosts_every_15m',
      'dexscreener_takeovers_every_15m',
      'dexscreener_market_every_10m',
      'goplus_security_worker_every_15m'
    )
  loop
    perform cron.unschedule(jid);
  end loop;
exception when others then
  null;
end;
$$;

-- profiles (special 60rpm) -> 15m
select
  cron.schedule(
    'dexscreener_profiles_every_15m',
    '*/15 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/fetch-dexscreener-latest',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

-- boosts/latest (special 60rpm) -> 30m
select
  cron.schedule(
    'dexscreener_boosts_every_30m',
    '*/30 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/fetch-dexscreener-boosts',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

-- boosts/top (special 60rpm) -> 60m
select
  cron.schedule(
    'dexscreener_boosts_top_every_60m',
    '0 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/fetch-dexscreener-boosts-top',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

-- takeovers (special 60rpm) -> 60m
select
  cron.schedule(
    'dexscreener_takeovers_every_60m',
    '0 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/fetch-dexscreener-takeovers',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

-- market(tokens/v1, 300rpm) -> 15m
do $$
declare
  jid2 integer;
begin
  for jid2 in select jobid from cron.job where jobname = 'dexscreener_market_every_15m' loop
    perform cron.unschedule(jid2);
  end loop;
exception when others then
  null;
end;
$$;

select
  cron.schedule(
    'dexscreener_market_every_15m',
    '*/15 * * * *',
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

-- GoPlus worker -> 30m (CU budget still enforced in worker)
select
  cron.schedule(
    'goplus_security_worker_every_30m',
    '*/30 * * * *',
    $$
    select net.http_post(
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

