-- Update ops status RPC to show relevant cron jobs even if names change.

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
  select exists(select 1 from vault.secrets where name = 'project_url') into has_project_url;
  select exists(select 1 from vault.secrets where name = 'dexswipe_cron_secret') into has_cron_secret;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into jobs
  from (
    select jobid, jobname, schedule, active
    from cron.job
    where jobname like 'dexscreener_%'
       or jobname like 'goplus_%'
       or jobname like 'dexswipe_%'
    order by jobname
  ) t;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into runs
  from (
    select j.jobname, d.status, d.start_time, d.end_time, d.return_message
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where j.jobname like 'dexscreener_%'
       or j.jobname like 'goplus_%'
       or j.jobname like 'dexswipe_%'
    order by d.start_time desc
    limit 30
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

