-- Legacy migration (historical).
-- NOTE: This was used only for early smoke testing.
-- Current pipeline drops this object in 20260207070000_cleanup_unused.sql

create or replace function public.ping()
returns text
language sql
stable
as $$
  select 'pong'::text;
$$;

grant execute on function public.ping() to anon, authenticated;

