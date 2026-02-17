-- Free-tier lean RC adjustments (500MB friendly) + round-robin scheduled fetch
--
-- Goals:
-- - tokens: add last_fetched_at
-- - seen_tokens: minimal columns (user_device_id, token_id, created_at) with composite index
-- - GC: delete tokens not fetched in 24h and not in wishlist (if wishlist exists)
-- - Limit indexes: keep only (chain_id, created_at) + (user_device_id, token_id)
-- - Add scheduled-fetch edge function schedule every 5m (function decides what to fetch)

-- 1) tokens: add last_fetched_at and reduce indexes
alter table public.tokens
  add column if not exists last_fetched_at timestamptz;

-- Drop extra indexes to reduce storage
drop index if exists public.idx_tokens_updated_at;
drop index if exists public.idx_tokens_liquidity;
drop index if exists public.idx_tokens_created;

create index if not exists idx_tokens_chain_created_at
  on public.tokens (chain_id, created_at desc);

-- 2) seen_tokens: rename + remove FK dependency (so tokens TTL deletion doesn't delete seen history)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='seen_tokens' and column_name='client_id'
  ) then
    alter table public.seen_tokens rename column client_id to user_device_id;
  end if;
exception when others then
  null;
end;
$$;

-- Drop FK to tokens if present (name unknown -> dynamic lookup)
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.seen_tokens'::regclass
      and contype = 'f'
  loop
    execute format('alter table public.seen_tokens drop constraint %I', c.conname);
  end loop;
exception when others then
  null;
end;
$$;

-- Ensure minimal columns exist
alter table public.seen_tokens
  add column if not exists user_device_id text;

-- Ensure PK (user_device_id, token_id)
do $$
begin
  -- If PK exists but on old column names, we keep it; otherwise create a PK if none.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.seen_tokens'::regclass
      and contype = 'p'
  ) then
    alter table public.seen_tokens add primary key (user_device_id, token_id);
  end if;
exception when others then
  null;
end;
$$;

drop index if exists public.idx_seen_tokens_client_token;
create index if not exists idx_seen_tokens_user_device_token
  on public.seen_tokens (user_device_id, token_id);

-- Update RLS policies to use user_device_id
do $$
begin
  if exists (
    select 1 from pg_policies where schemaname='public' and tablename='seen_tokens' and policyname='seen_tokens_insert_own'
  ) then
    drop policy seen_tokens_insert_own on public.seen_tokens;
  end if;
  create policy seen_tokens_insert_own
    on public.seen_tokens
    for insert
    with check (
      user_device_id is not null
      and length(user_device_id) between 4 and 128
      and user_device_id = coalesce(current_setting('request.headers', true)::jsonb->>'x-client-id', '')
    );
exception when others then
  null;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_policies where schemaname='public' and tablename='seen_tokens' and policyname='seen_tokens_select_own'
  ) then
    drop policy seen_tokens_select_own on public.seen_tokens;
  end if;
  create policy seen_tokens_select_own
    on public.seen_tokens
    for select
    using (
      user_device_id = coalesce(current_setting('request.headers', true)::jsonb->>'x-client-id', '')
    );
exception when others then
  null;
end;
$$;

-- 3) GC: delete tokens not fetched within 24h and not wishlisted (if wishlist exists).
create or replace function public.dexswipe_gc_tokens_24h()
returns jsonb
language plpgsql
security definer
as $$
declare
  deleted_count integer := 0;
  wishlist_exists boolean := (to_regclass('public.wishlist') is not null);
  wishlist_has_token_id boolean := false;
  sql text;
begin
  if wishlist_exists then
    select exists(
      select 1
      from information_schema.columns
      where table_schema='public' and table_name='wishlist' and column_name='token_id'
    ) into wishlist_has_token_id;
  end if;

  if wishlist_exists and wishlist_has_token_id then
    sql := $q$
      delete from public.tokens t
      where t.last_fetched_at < now() - interval '24 hours'
        and not exists (select 1 from public.wishlist w where w.token_id = t.token_id)
    $q$;
  else
    sql := $q$
      delete from public.tokens t
      where t.last_fetched_at < now() - interval '24 hours'
    $q$;
  end if;

  execute sql;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('ok', true, 'deleted_tokens', deleted_count);
end;
$$;

-- Run GC hourly (lightweight) at minute 50.
select
  cron.schedule(
    'dexswipe_gc_tokens_hourly',
    '50 * * * *',
    $$ select public.dexswipe_gc_tokens_24h(); $$
  );

-- 4) Tighten retention to keep DB lean (raw/caches can overflow 500MB fast on multi-chain)
create or replace function public.dexswipe_cleanup_daily_430am_kst()
returns jsonb
language plpgsql
security definer
as $$
declare
  now_kst timestamp := (now() at time zone 'Asia/Seoul');
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  did_update integer := 0;

  deleted_runs integer := 0;
  deleted_queue integer := 0;
  deleted_quality_queue integer := 0;
  deleted_market_queue integer := 0;
  deleted_profiles integer := 0;
  deleted_boosts integer := 0;
  deleted_boosts_top integer := 0;
  deleted_takeovers integer := 0;
  deleted_market integer := 0;
  deleted_goplus integer := 0;
  deleted_url_risk integer := 0;
  deleted_rugpull integer := 0;
  deleted_heartbeats integer := 0;
begin
  if extract(hour from now_kst) <> 4 or extract(minute from now_kst) <> 30 then
    return jsonb_build_object('skipped', true, 'reason', 'not_0430_kst', 'now_kst', now_kst);
  end if;

  insert into public.dexswipe_maintenance_state (job_name, last_run_kst_date)
  values ('dexswipe_cleanup_daily_430am_kst', today_kst)
  on conflict (job_name) do update
    set last_run_kst_date = excluded.last_run_kst_date
    where public.dexswipe_maintenance_state.last_run_kst_date is distinct from excluded.last_run_kst_date;

  get diagnostics did_update = row_count;
  if did_update = 0 then
    return jsonb_build_object('skipped', true, 'reason', 'already_ran_today', 'today_kst', today_kst);
  end if;

  -- Keep ingestion logs short
  delete from public.dexscreener_ingestion_runs
  where started_at < now() - interval '7 days';
  get diagnostics deleted_runs = row_count;

  -- Queues: keep completed only 2 days
  delete from public.token_security_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_queue = row_count;

  delete from public.token_quality_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_quality_queue = row_count;

  delete from public.dexscreener_market_update_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_market_queue = row_count;

  -- Raw: keep 7 days
  delete from public.dexscreener_token_profiles_raw
  where updated_at < now() - interval '7 days';
  get diagnostics deleted_profiles = row_count;

  delete from public.dexscreener_token_boosts_raw
  where updated_at < now() - interval '7 days';
  get diagnostics deleted_boosts = row_count;

  delete from public.dexscreener_token_boosts_top_raw
  where updated_at < now() - interval '7 days';
  get diagnostics deleted_boosts_top = row_count;

  delete from public.dexscreener_community_takeovers_raw
  where updated_at < now() - interval '7 days';
  get diagnostics deleted_takeovers = row_count;

  -- Market derived data: keep 3 days
  delete from public.dexscreener_token_market_data
  where updated_at < now() - interval '3 days';
  get diagnostics deleted_market = row_count;

  -- GoPlus caches: keep 7 days
  delete from public.goplus_token_security_cache
  where scanned_at < now() - interval '7 days';
  get diagnostics deleted_goplus = row_count;

  delete from public.goplus_url_risk_cache
  where scanned_at < now() - interval '7 days';
  get diagnostics deleted_url_risk = row_count;

  delete from public.goplus_rugpull_cache
  where scanned_at < now() - interval '7 days';
  get diagnostics deleted_rugpull = row_count;

  delete from public.edge_function_heartbeats
  where ran_at < now() - interval '7 days';
  get diagnostics deleted_heartbeats = row_count;

  return jsonb_build_object(
    'ok', true,
    'ran_at_kst', now_kst,
    'deleted', jsonb_build_object(
      'dexscreener_ingestion_runs', deleted_runs,
      'token_security_scan_queue', deleted_queue,
      'token_quality_scan_queue', deleted_quality_queue,
      'dexscreener_market_update_queue', deleted_market_queue,
      'dexscreener_token_profiles_raw', deleted_profiles,
      'dexscreener_token_boosts_raw', deleted_boosts,
      'dexscreener_token_boosts_top_raw', deleted_boosts_top,
      'dexscreener_community_takeovers_raw', deleted_takeovers,
      'dexscreener_token_market_data', deleted_market,
      'goplus_token_security_cache', deleted_goplus,
      'goplus_url_risk_cache', deleted_url_risk,
      'goplus_rugpull_cache', deleted_rugpull,
      'edge_function_heartbeats', deleted_heartbeats
    )
  );
end;
$$;

-- 5) Schedule round-robin fetch runner every 5 minutes (function decides what to fetch)
select
  cron.schedule(
    'dexswipe_scheduled_fetch_every_5m',
    '*/5 * * * *',
    $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
            || '/functions/v1/scheduled-fetch',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );

