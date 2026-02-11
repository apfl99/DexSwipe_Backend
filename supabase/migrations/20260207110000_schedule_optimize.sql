-- Schedule optimization for free-tier usage
-- DexScreener rate limits (official): 60 rpm for latest endpoints, 300 rpm for tokens/v1
-- Ref: https://docs.dexscreener.com/api/reference

do $$
begin
  -- remove legacy daily job if exists
  begin
    perform cron.unschedule('dexscreener_daily_5am_kst');
  exception when others then
    null;
  end;

  -- replace GoPlus worker schedule (was every 5m) -> every 15m (free-tier friendly)
  begin
    perform cron.unschedule('goplus_security_worker_every_5m');
  exception when others then
    null;
  end;
end;
$$;

-- DexScreener: profiles every 5 minutes (<= 60 rpm)
select
  cron.schedule(
    'dexscreener_profiles_every_5m',
    '*/5 * * * *',
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

-- DexScreener: boosts every 15 minutes (<= 60 rpm)
select
  cron.schedule(
    'dexscreener_boosts_every_15m',
    '*/15 * * * *',
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

-- DexScreener: takeovers every 15 minutes (<= 60 rpm)
select
  cron.schedule(
    'dexscreener_takeovers_every_15m',
    '*/15 * * * *',
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

-- GoPlus worker: every 15 minutes (CU budget is enforced in worker logic)
select
  cron.schedule(
    'goplus_security_worker_every_15m',
    '*/15 * * * *',
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

