-- DexScreener ingestion (raw) + daily scheduling (05:00 KST)

-- Extensions
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;
create extension if not exists supabase_vault with schema extensions;

-- Raw storage table: store *all* fields from DexScreener response in JSONB.
-- Requirement: "dexscreener로부터 받아온 데이터 전부"
create table if not exists public.dexscreener_token_profiles_raw (
  chain_id text not null,
  token_address text not null,
  raw jsonb not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_id uuid,
  primary key (chain_id, token_address)
);

create index if not exists idx_dexscreener_profiles_fetched_at
  on public.dexscreener_token_profiles_raw (fetched_at desc);

-- Ingestion run log
create table if not exists public.dexscreener_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running', -- running | completed | failed
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0,
  upserted_count integer not null default 0,
  error_message text
);

create index if not exists idx_dexscreener_runs_started_at
  on public.dexscreener_ingestion_runs (started_at desc);

-- Job state (avoid running more than once per KST day)
create table if not exists public.dexscreener_job_state (
  job_name text primary key,
  last_run_kst_date date
);

-- Security posture: keep raw tables private by default
alter table public.dexscreener_token_profiles_raw enable row level security;
alter table public.dexscreener_ingestion_runs enable row level security;
alter table public.dexscreener_job_state enable row level security;

-- Function invoked by pg_cron every hour; runs only at 05:00 KST, once per day.
create or replace function public.run_dexscreener_daily_5am_kst()
returns void
language plpgsql
security definer
as $$
declare
  now_kst timestamp := (now() at time zone 'Asia/Seoul');
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  did_update integer := 0;
  project_url text;
  cron_secret text;
begin
  -- Only run at 05:00 KST exactly
  if extract(hour from now_kst) <> 5 or extract(minute from now_kst) <> 0 then
    return;
  end if;

  insert into public.dexscreener_job_state (job_name, last_run_kst_date)
  values ('dexscreener_daily_5am_kst', today_kst)
  on conflict (job_name) do update
    set last_run_kst_date = excluded.last_run_kst_date
    where public.dexscreener_job_state.last_run_kst_date is distinct from excluded.last_run_kst_date;

  get diagnostics did_update = row_count;
  if did_update = 0 then
    -- already ran today
    return;
  end if;

  -- Secrets are pulled from Vault (recommended by Supabase docs)
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'project_url';

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'dexswipe_cron_secret';

  if project_url is null then
    raise exception 'Missing vault secret: project_url';
  end if;
  if cron_secret is null then
    raise exception 'Missing vault secret: dexswipe_cron_secret';
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/fetch-dexscreener-latest',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  );

  -- Also refresh boosts + community takeovers daily (05:00 KST)
  perform net.http_post(
    url := project_url || '/functions/v1/fetch-dexscreener-boosts',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  );

  perform net.http_post(
    url := project_url || '/functions/v1/fetch-dexscreener-takeovers',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  );
end;
$$;

-- Schedule the checker to run every hour at minute 0.
-- The function itself enforces "05:00 KST, once per day".
select
  cron.schedule(
    'dexscreener_daily_5am_kst',
    '0 * * * *',
    $$ select public.run_dexscreener_daily_5am_kst(); $$
  );

