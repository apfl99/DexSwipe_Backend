-- Intersection Rule enforcement at DB level:
-- prevent non-allowlisted chains from entering queues/tokens.

do $$
begin
  -- Cleanup existing rows outside allowlist.
  delete from public.dexscreener_market_update_queue
  where chain_id not in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron');

  delete from public.token_security_scan_queue
  where chain_id not in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron');

  delete from public.token_quality_scan_queue
  where chain_id not in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron');

  delete from public.tokens
  where chain_id not in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron');

  -- Add CHECK constraints (idempotent).
  if not exists (select 1 from pg_constraint where conname = 'dexswipe_market_queue_chain_allowlist') then
    alter table public.dexscreener_market_update_queue
      add constraint dexswipe_market_queue_chain_allowlist
      check (chain_id in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dexswipe_security_queue_chain_allowlist') then
    alter table public.token_security_scan_queue
      add constraint dexswipe_security_queue_chain_allowlist
      check (chain_id in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dexswipe_quality_queue_chain_allowlist') then
    alter table public.token_quality_scan_queue
      add constraint dexswipe_quality_queue_chain_allowlist
      check (chain_id in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dexswipe_tokens_chain_allowlist') then
    alter table public.tokens
      add constraint dexswipe_tokens_chain_allowlist
      check (chain_id in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron'));
  end if;
end $$;

