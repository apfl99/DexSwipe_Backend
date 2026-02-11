-- Release cleanup: remove legacy daily-only DexScreener cron function/state (no longer used)

-- Unschedule if it still exists (by jobname -> jobid)
do $$
declare
  jid integer;
begin
  select jobid into jid from cron.job where jobname = 'dexscreener_daily_5am_kst' limit 1;
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
exception when others then
  null;
end;
$$;

drop function if exists public.run_dexscreener_daily_5am_kst();
drop table if exists public.dexscreener_job_state cascade;

