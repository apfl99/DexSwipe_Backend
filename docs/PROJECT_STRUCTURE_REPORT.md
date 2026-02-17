## Project Structure Report (DexSwipe Backend RC)

### Pipeline 문서

- `docs/PIPELINE.md` 참고 (크론 스케줄/데이터 흐름/테이블/환경변수까지 포함)

### Active Public API

- **Edge Function**: `supabase/functions/get-feed/index.ts`
  - Required header: `x-client-id`
  - Pagination: cursor(keyset) using `tokens.updated_at`
- Anti-join: `NOT EXISTS` on `seen_tokens(user_device_id, token_id)`
  - Smart fields: `is_surging`, `safety_score` (0~100)

- **Edge Function**: `supabase/functions/wishlist/index.ts`
  - `GET/POST/DELETE /functions/v1/wishlist`
  - Required header: `x-client-id`

### Active Pipeline (Cron / Workers)

- **DexScreener ingestion (lean, free-tier)**
  - `supabase/functions/scheduled-fetch/index.ts` (round-robin enqueue)
    - Solana/Base: `/token-profiles/latest/v1`
    - Sui/Tron: `/latest/dex/search` + chainId filter (fallback query 포함)
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
  - `public.wishlist`
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

