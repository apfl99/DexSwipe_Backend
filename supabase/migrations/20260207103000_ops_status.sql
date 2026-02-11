-- Operational status helpers (diagnostics)

create or replace function public.dexswipe_ops_status()
returns jsonb
language plpgsql
security definer
as $$
declare
  has_project_url boolean;
  has_cron_secret boolean;
  jobs jsonb;
  runs jsonb;
begin
  -- Check Vault secret presence without exposing values
  select exists(select 1 from vault.secrets where name = 'project_url') into has_project_url;
  select exists(select 1 from vault.secrets where name = 'dexswipe_cron_secret') into has_cron_secret;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into jobs
  from (
    select jobid, jobname, schedule, active
    from cron.job
    where jobname in (
      'dexscreener_profiles_every_5m',
      'dexscreener_boosts_every_15m',
      'dexscreener_takeovers_every_15m',
      'dexscreener_market_every_10m',
      'goplus_security_worker_every_15m',
      'dexswipe_cleanup_daily_430am_kst'
    )
    order by jobname
  ) t;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into runs
  from (
    select j.jobname, d.status, d.start_time, d.end_time, d.return_message
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'dexscreener_profiles_every_5m',
      'dexscreener_boosts_every_15m',
      'dexscreener_takeovers_every_15m',
      'dexscreener_market_every_10m',
      'goplus_security_worker_every_15m',
      'dexswipe_cleanup_daily_430am_kst'
    )
    order by d.start_time desc
    limit 20
  ) t;

  return jsonb_build_object(
    'vault', jsonb_build_object(
      'has_project_url', has_project_url,
      'has_dexswipe_cron_secret', has_cron_secret
    ),
    'cron_jobs', jobs,
    'recent_runs', runs
  );
end;
$$;

grant execute on function public.dexswipe_ops_status() to service_role;

