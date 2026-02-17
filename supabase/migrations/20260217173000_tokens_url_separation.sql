-- URL separation: Dex chart vs Official website.
-- Also store basic social links for frontend buttons.

alter table public.tokens
  add column if not exists dex_chart_url text,
  add column if not exists official_website_url text,
  add column if not exists twitter_url text,
  add column if not exists telegram_url text;

