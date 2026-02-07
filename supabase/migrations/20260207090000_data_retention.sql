-- Data retention / cleanup (auto)
--
-- Policy (can be tuned later):
-- - dexscreener_ingestion_runs: keep 14 days
-- - token_security_scan_queue: delete completed older than 7 days
-- - raw token tables: keep 30 days since updated_at
-- - goplus_token_security_cache: keep 30 days since scanned_at
--
-- Runs daily at 04:30 KST (Asia/Seoul). We schedule an hourly check and gate by KST.

create table if not exists public.dexswipe_maintenance_state (
  job_name text primary key,
  last_run_kst_date date
);

alter table public.dexswipe_maintenance_state enable row level security;

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
  deleted_takeovers integer := 0;
  deleted_goplus integer := 0;
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

  delete from public.dexscreener_ingestion_runs
  where started_at < now() - interval '14 days';
  get diagnostics deleted_runs = row_count;

  delete from public.token_security_scan_queue
  where status = 'completed'
    and updated_at < now() - interval '7 days';
  get diagnostics deleted_queue = row_count;

  delete from public.dexscreener_token_profiles_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_profiles = row_count;

  delete from public.dexscreener_token_boosts_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_boosts = row_count;

  delete from public.dexscreener_community_takeovers_raw
  where updated_at < now() - interval '30 days';
  get diagnostics deleted_takeovers = row_count;

  delete from public.goplus_token_security_cache
  where scanned_at < now() - interval '30 days';
  get diagnostics deleted_goplus = row_count;

  return jsonb_build_object(
    'ok', true,
    'ran_at_kst', now_kst,
    'deleted', jsonb_build_object(
      'dexscreener_ingestion_runs', deleted_runs,
      'token_security_scan_queue', deleted_queue,
      'dexscreener_token_profiles_raw', deleted_profiles,
      'dexscreener_token_boosts_raw', deleted_boosts,
      'dexscreener_community_takeovers_raw', deleted_takeovers,
      'goplus_token_security_cache', deleted_goplus
    )
  );
end;
$$;

-- Only service_role can manually invoke this RPC (debug)
grant execute on function public.dexswipe_cleanup_daily_430am_kst() to service_role;

-- Schedule hourly at minute 30; function gates at 04:30 KST.
select
  cron.schedule(
    'dexswipe_cleanup_daily_430am_kst',
    '30 * * * *',
    $$ select public.dexswipe_cleanup_daily_430am_kst(); $$
  );

