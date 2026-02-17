-- Hunter's Tracking Engine: wishlist capture fields + tokens TTL at UTC midnight + feed anti-join includes wishlist
--
-- Requirements:
-- - wishlist: persistent inventory, record captured_price & captured_at at save time
-- - tokens: transient feed snapshot, delete non-wishlisted rows older than 24h (daily at 00:00 UTC)
-- - get-feed anti-join must exclude seen_tokens + wishlist for the device

-- 1) wishlist capture fields
alter table public.wishlist
  add column if not exists captured_price numeric,
  add column if not exists captured_at timestamptz;

-- Backfill captured_at for existing rows (best-effort)
update public.wishlist
set captured_at = coalesce(captured_at, created_at, now())
where captured_at is null;

-- 2) tokens GC: delete tokens older than 24h and NOT in wishlist
create or replace function public.dexswipe_gc_tokens_24h_unless_wishlisted()
returns jsonb
language plpgsql
security definer
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.tokens t
  where coalesce(t.updated_at, t.last_fetched_at, t.created_at) < now() - interval '24 hours'
    and not exists (
      select 1
      from public.wishlist w
      where w.token_id = t.token_id
    );

  get diagnostics deleted_count = row_count;
  return jsonb_build_object('ok', true, 'deleted_tokens', deleted_count);
end;
$$;

-- Unschedule old hourly GC if present (name may exist)
do $$
declare
  r record;
begin
  for r in
    select jobid
    from cron.job
    where jobname in ('dexswipe_gc_tokens_hourly')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
exception when others then
  null;
end;
$$;

-- Schedule daily GC at midnight UTC
do $$
declare
  jid integer;
begin
  select jobid into jid from cron.job where jobname = 'dexswipe_gc_tokens_daily_midnight_utc' limit 1;
  if jid is null then
    perform cron.schedule(
      'dexswipe_gc_tokens_daily_midnight_utc',
      '0 0 * * *',
      $cron$ select public.dexswipe_gc_tokens_24h_unless_wishlisted(); $cron$
    );
  end if;
exception when others then
  null;
end;
$$;

-- 3) Feed RPC: anti-join must exclude wishlist too (device-based)
-- Change return type already happened earlier; we drop and recreate to be safe.
drop function if exists public.dexswipe_get_feed(
  text,
  integer,
  timestamptz,
  text[],
  numeric,
  numeric,
  numeric,
  boolean
);

create function public.dexswipe_get_feed(
  p_client_id text,
  p_limit integer default 30,
  p_cursor timestamptz default null,
  p_chains text[] default null,
  p_min_liquidity_usd numeric default null,
  p_min_volume_24h numeric default null,
  p_min_fdv numeric default null,
  p_include_risky boolean default false
)
returns table (
  token_id text,
  chain_id text,
  token_address text,
  name text,
  symbol text,
  logo_url text,
  website_url text,
  price_usd numeric,
  liquidity_usd numeric,
  volume_24h numeric,
  fdv numeric,
  market_cap numeric,
  price_change_5m numeric,
  price_change_15m numeric,
  price_change_1h numeric,
  buys_24h integer,
  sells_24h integer,
  pair_created_at timestamptz,
  updated_at timestamptz,
  security_always_deny boolean,
  security_deny_reasons text[],
  security_scanned_at timestamptz,
  url_is_phishing boolean,
  url_dapp_risk_level text,
  url_scanned_at timestamptz,
  rug_is_rugpull_risk boolean,
  rug_risk_level text,
  rug_scanned_at timestamptz
)
language sql
stable
as $$
  with base as (
    select t.*
    from public.tokens t
    left join public.seen_tokens st
      on st.user_device_id = p_client_id
     and st.token_id = t.token_id
    left join public.wishlist w
      on w.user_device_id = p_client_id
     and w.token_id = t.token_id
    where st.token_id is null
      and w.token_id is null
      and (p_cursor is null or t.updated_at < p_cursor)
      and (p_chains is null or t.chain_id = any(p_chains))
      and (p_min_liquidity_usd is null or coalesce(t.liquidity_usd, 0) >= p_min_liquidity_usd)
      and (p_min_volume_24h is null or coalesce(t.volume_24h, 0) >= p_min_volume_24h)
      and (p_min_fdv is null or coalesce(t.fdv, 0) >= p_min_fdv)
    order by t.updated_at desc
    limit greatest(1, least(p_limit, 100))
  )
  select
    b.token_id,
    b.chain_id,
    b.token_address,
    b.name,
    b.symbol,
    b.logo_url,
    b.website_url,
    b.price_usd,
    b.liquidity_usd,
    b.volume_24h,
    b.fdv,
    b.market_cap,
    b.price_change_5m,
    b.price_change_15m,
    b.price_change_1h,
    b.buys_24h,
    b.sells_24h,
    b.pair_created_at,
    b.updated_at,
    s.always_deny as security_always_deny,
    s.deny_reasons as security_deny_reasons,
    s.scanned_at as security_scanned_at,
    ur.is_phishing as url_is_phishing,
    ur.dapp_risk_level as url_dapp_risk_level,
    ur.scanned_at as url_scanned_at,
    rp.is_rugpull_risk as rug_is_rugpull_risk,
    rp.risk_level as rug_risk_level,
    rp.scanned_at as rug_scanned_at
  from base b
  left join public.goplus_token_security_cache s
    on s.chain_id = b.chain_id and s.token_address = b.token_address
  left join public.goplus_url_risk_cache ur
    on ur.url = b.website_url
  left join public.goplus_rugpull_cache rp
    on rp.chain_id = b.chain_id and rp.token_address = b.token_address
  where coalesce(s.always_deny, false) = false
    and (
      p_include_risky
      or (coalesce(ur.is_phishing, false) = false and coalesce(rp.is_rugpull_risk, false) = false)
    )
  order by b.updated_at desc;
$$;

