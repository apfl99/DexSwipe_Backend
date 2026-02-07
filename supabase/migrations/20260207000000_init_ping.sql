-- Minimal remote-first baseline migration
-- 목적: 원격 Supabase에 푸시 후, PostgREST RPC로 간단히 동작 확인 가능하게 함.
--
-- 호출 예:
--   curl -X POST "$SUPABASE_URL/rest/v1/rpc/ping" \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{}'

-- Schema (public) is already present in Supabase, but keep grants explicit.
create or replace function public.ping()
returns text
language sql
stable
as $$
  select 'pong'::text;
$$;

-- Allow API roles to call it (Supabase uses these roles for PostgREST)
grant execute on function public.ping() to anon, authenticated;

