-- Cleanup: drop unused ingestion tables/functions and old cron jobs (release minimal set)
-- Keep only:
-- - tokens, seen_tokens, queues, GoPlus caches
-- - scheduled-fetch, fetch-dexscreener-market, get-feed, goplus workers

-- 1) Unschedule legacy dexscreener_* cron jobs (we now use scheduled-fetch + market worker)
do $$
declare
  r record;
begin
  for r in
    select jobid
    from cron.job
    where jobname like 'dexscreener_%'
  loop
    perform cron.unschedule(r.jobid);
  end loop;
exception when others then
  null;
end;
$$;

-- Ensure market worker schedule exists (minimal)
do $$
declare
  jid integer;
begin
  select jobid into jid from cron.job where jobname = 'dexswipe_market_worker_every_5m' limit 1;
  if jid is null then
    perform cron.schedule(
      'dexswipe_market_worker_every_5m',
      '*/5 * * * *',
      $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
              || '/functions/v1/fetch-dexscreener-market',
        headers := jsonb_build_object(
          'Content-type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dexswipe_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
      $cron$
    );
  end if;
exception when others then
  null;
end;
$$;

-- 2) Replace daily cleanup to not reference dropped tables
create or replace function public.dexswipe_cleanup_daily_430am_kst()
returns jsonb
language plpgsql
security definer
as $$
declare
  now_kst timestamp := (now() at time zone 'Asia/Seoul');
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  did_update integer := 0;

  deleted_seen integer := 0;
  deleted_sec_queue integer := 0;
  deleted_quality_queue integer := 0;
  deleted_market_queue integer := 0;
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

  -- Keep seen history bounded (storage protection)
  delete from public.seen_tokens
  where created_at < now() - interval '30 days';
  get diagnostics deleted_seen = row_count;

  -- Queues: keep completed only 2 days
  delete from public.token_security_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_sec_queue = row_count;

  delete from public.token_quality_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_quality_queue = row_count;

  delete from public.dexscreener_market_update_queue
  where status = 'completed'
    and updated_at < now() - interval '2 days';
  get diagnostics deleted_market_queue = row_count;

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
      'seen_tokens', deleted_seen,
      'token_security_scan_queue', deleted_sec_queue,
      'token_quality_scan_queue', deleted_quality_queue,
      'dexscreener_market_update_queue', deleted_market_queue,
      'goplus_token_security_cache', deleted_goplus,
      'goplus_url_risk_cache', deleted_url_risk,
      'goplus_rugpull_cache', deleted_rugpull,
      'edge_function_heartbeats', deleted_heartbeats
    )
  );
end;
$$;

-- 3) Drop unused ingestion tables (space critical on free tier)
drop table if exists public.dexscreener_token_market_data cascade;
drop table if exists public.dexscreener_token_profiles_raw cascade;
drop table if exists public.dexscreener_token_boosts_raw cascade;
drop table if exists public.dexscreener_token_boosts_top_raw cascade;
drop table if exists public.dexscreener_community_takeovers_raw cascade;
drop table if exists public.dexscreener_ingestion_runs cascade;
drop table if exists public.dexscreener_job_state cascade;

