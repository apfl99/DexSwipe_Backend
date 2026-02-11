-- Extend retention cleanup for newly added release tables:
-- - dexscreener_market_update_queue
-- - dexscreener_token_market_data
-- - dexscreener_token_boosts_top_raw
-- - token_quality_scan_queue
-- - goplus_url_risk_cache
-- - goplus_rugpull_cache
-- - edge_function_heartbeats

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
  deleted_profiles integer := 0;
  deleted_boosts integer := 0;
  deleted_boosts_top integer := 0;
  deleted_takeovers integer := 0;
  deleted_market integer := 0;
  deleted_market_queue integer := 0;
  deleted_goplus integer := 0;
  deleted_quality_queue integer := 0;
  deleted_url_risk integer := 0;
  deleted_rugpull integer := 0;
  deleted_heartbeats integer := 0;
begin
  -- Only run at 04:30 KST
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

  -- Ingestion runs
  delete from public.dexscreener_ingestion_runs
  where started_at < now() - interval '14 days';
  get diagnostics deleted_runs = row_count;

  -- Job queues
  delete from public.token_security_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '7 days';
  get diagnostics deleted_queue = row_count;

  delete from public.token_quality_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '7 days';
  get diagnostics deleted_quality_queue = row_count;

  delete from public.dexscreener_market_update_queue
  where status = 'completed'
    and updated_at < now() - interval '7 days';
  get diagnostics deleted_market_queue = row_count;

  -- Raw/derived token data
  delete from public.dexscreener_token_profiles_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_profiles = row_count;

  delete from public.dexscreener_token_boosts_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_boosts = row_count;

  delete from public.dexscreener_token_boosts_top_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_boosts_top = row_count;

  delete from public.dexscreener_community_takeovers_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_takeovers = row_count;

  delete from public.dexscreener_token_market_data
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_market = row_count;

  -- GoPlus caches
  delete from public.goplus_token_security_cache
  where scanned_at < now() - interval '30 days';
  get diagnostics deleted_goplus = row_count;

  delete from public.goplus_url_risk_cache
  where scanned_at < now() - interval '30 days';
  get diagnostics deleted_url_risk = row_count;

  delete from public.goplus_rugpull_cache
  where scanned_at < now() - interval '30 days';
  get diagnostics deleted_rugpull = row_count;

  -- Ops telemetry
  delete from public.edge_function_heartbeats
  where ran_at < now() - interval '30 days';
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

