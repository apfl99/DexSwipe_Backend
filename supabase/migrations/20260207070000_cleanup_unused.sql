-- Cleanup: remove DB objects not used by current pipeline.

-- Legacy ping function (from early smoke test)
drop function if exists public.ping();

-- Unused (prepared but not currently ingested/served)
drop table if exists public.dexscreener_pairs_raw cascade;

