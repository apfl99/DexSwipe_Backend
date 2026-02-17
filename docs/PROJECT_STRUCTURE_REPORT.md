## Project Structure Report (DexSwipe Backend RC)

### Active Public API

- **Edge Function**: `supabase/functions/get-feed/index.ts`
  - Required header: `x-client-id`
  - Pagination: cursor(keyset) using `tokens.updated_at`
- Anti-join: `NOT EXISTS` on `seen_tokens(user_device_id, token_id)`

### Active Pipeline (Cron / Workers)

- **DexScreener ingestion (lean, free-tier)**
  - `supabase/functions/scheduled-fetch/index.ts` (round-robin enqueue)
  - `supabase/functions/fetch-dexscreener-market/index.ts` (drains queue, upserts `tokens`)
  - Shared: `supabase/functions/_shared/dexscreener.ts` (retry/backoff)
- **GoPlus**
  - `supabase/functions/goplus-security-worker/index.ts`
  - `supabase/functions/goplus-quality-worker/index.ts`
- **Scripts**
  - `scripts/verify_pipeline.sh`
  - `scripts/push_remote_migrations.sh`
  - `scripts/dotenv.sh`

### Active Schema (tables/views/functions)

- **Release-oriented**
  - `public.tokens`
  - `public.seen_tokens`
  - `public.security_cache` (view -> `public.goplus_token_security_cache`)
  - `public.dexswipe_get_feed(...)` (RPC)
- **Ingestion**
  - `public.dexscreener_market_update_queue`
- **Queues**
  - `public.token_security_scan_queue`
  - `public.token_quality_scan_queue`
- **Caches**
  - `public.goplus_token_security_cache`
  - `public.goplus_url_risk_cache`
  - `public.goplus_rugpull_cache`
- **Ops**
  - `public.edge_function_heartbeats`
  - `public.dexswipe_ops_status()`
  - `public.dexswipe_cleanup_daily_430am_kst()`

### Deprecated / Not required for frontend

- Frontend does **not** call ingestion/worker functions directly. They are cron/ops only.

