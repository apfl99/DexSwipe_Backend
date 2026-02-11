-- Cleanup: remove DB objects not used by current pipeline.

-- Legacy ping function (from early smoke test)
-- NOTE: This function is not used by the release pipeline.
drop function if exists public.ping();

-- Unused (prepared but not currently ingested/served)
drop table if exists public.dexscreener_pairs_raw cascade;

