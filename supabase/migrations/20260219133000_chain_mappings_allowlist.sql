-- Ensure chain_mappings covers the intersection allowlist (DexScreener ∩ GoPlus).
-- Also clean up any persisted tokens outside allowlist.

insert into public.chain_mappings (dexscreener_chain_id, goplus_mode, goplus_chain_id)
values
  ('ethereum', 'evm', '1'),
  ('bsc', 'evm', '56'),
  ('base', 'evm', '8453'),
  ('arbitrum', 'evm', '42161'),
  ('polygon', 'evm', '137'),
  ('avalanche', 'evm', '43114'),
  ('solana', 'solana', null),
  ('tron', 'evm', 'tron')
on conflict (dexscreener_chain_id) do update
set
  goplus_mode = excluded.goplus_mode,
  goplus_chain_id = excluded.goplus_chain_id;

-- Drop any non-intersection chains already stored.
delete from public.tokens
where chain_id not in ('solana','base','bsc','ethereum','arbitrum','polygon','avalanche','tron');

