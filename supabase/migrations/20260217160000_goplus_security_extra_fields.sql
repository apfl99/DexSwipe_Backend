-- Extend GoPlus security cache fields for hybrid aggregator.
-- Required by API: trust_list, is_blacklisted.

alter table public.goplus_token_security_cache
  add column if not exists trust_list boolean,
  add column if not exists is_blacklisted boolean;

