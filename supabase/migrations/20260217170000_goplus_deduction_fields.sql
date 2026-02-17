-- Extend GoPlus token security cache fields for deduction-based safety scoring.
-- This migration is additive and safe on existing projects.

alter table public.goplus_token_security_cache
  add column if not exists cannot_sell_all boolean,
  add column if not exists transfer_pausable boolean,
  add column if not exists slippage_modifiable boolean,
  add column if not exists external_call boolean,
  add column if not exists owner_change_balance boolean,
  add column if not exists hidden_owner boolean,
  add column if not exists cannot_buy boolean,
  add column if not exists trading_cooldown boolean,
  add column if not exists is_open_source boolean,
  add column if not exists is_mintable boolean,
  add column if not exists take_back_ownership boolean;

