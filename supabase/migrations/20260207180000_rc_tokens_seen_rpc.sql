-- RC schema: tokens + seen_tokens + security_cache(view) + get-feed RPC
-- This migration introduces the release-oriented data model without renaming existing ingestion tables.
--
-- Requirements covered:
-- - tokens: price_change_1h, buys_24h, sells_24h
-- - seen_tokens: (client_id, token_id) composite key/index for anti-join
-- - RLS: anon can read tokens; anon can insert own seen_tokens (via x-client-id header)
-- - Anti-join + cursor pagination implemented in SQL (NOT EXISTS + keyset)

create table if not exists public.tokens (
  token_id text primary key, -- "{chain_id}:{token_address}"
  chain_id text not null,
  token_address text not null,

  name text,
  symbol text,
  logo_url text,
  website_url text,

  price_usd numeric,
  liquidity_usd numeric,
  volume_24h numeric,
  fdv numeric,
  market_cap numeric,

  -- Hype metrics (from DexScreener pair)
  price_change_1h numeric,
  buys_24h integer,
  sells_24h integer,

  pair_created_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (chain_id, token_address)
);

create index if not exists idx_tokens_updated_at on public.tokens (updated_at desc);
create index if not exists idx_tokens_liquidity on public.tokens (liquidity_usd desc nulls last);
create index if not exists idx_tokens_created on public.tokens (pair_created_at desc nulls last);

alter table public.tokens enable row level security;

-- Anon users can read tokens
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tokens' and policyname='tokens_select_all'
  ) then
    create policy tokens_select_all on public.tokens for select using (true);
  end if;
end;
$$;

create table if not exists public.seen_tokens (
  client_id text not null,
  token_id text not null,
  created_at timestamptz not null default now(),
  primary key (client_id, token_id)
);

-- Composite index is already covered by PK, but we keep an explicit name for clarity.
create index if not exists idx_seen_tokens_client_token on public.seen_tokens (client_id, token_id);

alter table public.seen_tokens enable row level security;

-- Allow anon to insert only their own client_id, bound to request header x-client-id (PostgREST).
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='seen_tokens' and policyname='seen_tokens_insert_own'
  ) then
    create policy seen_tokens_insert_own
      on public.seen_tokens
      for insert
      with check (
        client_id is not null
        and length(client_id) between 4 and 128
        and client_id = coalesce(current_setting('request.headers', true)::jsonb->>'x-client-id', '')
      );
  end if;
end;
$$;

-- Allow anon to read only their own seen rows (optional but helpful for debugging)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='seen_tokens' and policyname='seen_tokens_select_own'
  ) then
    create policy seen_tokens_select_own
      on public.seen_tokens
      for select
      using (
        client_id = coalesce(current_setting('request.headers', true)::jsonb->>'x-client-id', '')
      );
  end if;
end;
$$;

-- Compatibility: security_cache view (maps to existing goplus cache)
create or replace view public.security_cache as
select
  chain_id,
  token_address,
  raw,
  scanned_at,
  cannot_sell,
  is_honeypot,
  is_proxy,
  contract_upgradeable,
  buy_tax,
  sell_tax,
  always_deny,
  deny_reasons,
  trust_score
from public.goplus_token_security_cache;

-- Main feed RPC (keyset cursor + anti-join NOT EXISTS)
create or replace function public.dexswipe_get_feed(
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
    where (p_cursor is null or t.updated_at < p_cursor)
      and (p_chains is null or t.chain_id = any(p_chains))
      and (p_min_liquidity_usd is null or coalesce(t.liquidity_usd, 0) >= p_min_liquidity_usd)
      and (p_min_volume_24h is null or coalesce(t.volume_24h, 0) >= p_min_volume_24h)
      and (p_min_fdv is null or coalesce(t.fdv, 0) >= p_min_fdv)
      and not exists (
        select 1
        from public.seen_tokens st
        where st.client_id = p_client_id
          and st.token_id = t.token_id
      )
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

