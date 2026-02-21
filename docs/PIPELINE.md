## DexSwipe Backend Pipeline (Release Candidate)

### 목적

- **목표**: Supabase Free Tier 제약 내에서 “피드(저비용/고속) + 위시리스트(정확한 실시간 가격)”를 동시에 제공
- **핵심 원칙**
  - **DB는 캐시/스냅샷**(lean)로 유지하고, 프론트 요청 시 **실시간 병합(Hybrid)**으로 빈칸(`-`)을 최소화
  - **DexScreener(가격)** + **GoPlus(보안)**를 **병렬 처리**하여 단일 토큰 객체로 반환

---

### 전체 구성(한 눈에 보기)

- **수집(Background, pg_cron)**
  - `scheduled-fetch` → (큐) `dexscreener_market_update_queue` 적재
  - `fetch-dexscreener-market` → `tokens` 스냅샷 upsert
  - `goplus-security-worker` → `goplus_token_security_cache` 갱신
  - `goplus-quality-worker` → `goplus_url_risk_cache`, `goplus_rugpull_cache` 갱신
- **제공(Realtime, Edge Functions)**
  - `get-feed` → DB 후보 + DexScreener/GoPlus 실시간 병합 후 반환, 그리고 `seen_tokens` 기록
  - `get-wishlist` → 위시리스트 전량 DexScreener 실시간 동기화 + GoPlus 병합 후 반환
  - `wishlist` → 저장 시점 `captured_price/captured_at` 고정 기록

---

### 데이터 흐름 상세

#### 1) Candidate 수집(체인 라운드로빈)

- **함수**: `supabase/functions/scheduled-fetch/index.ts`
- **역할**: DexScreener에서 “후보 토큰”을 찾아 **큐**에 넣습니다.
- **입력**: pg_cron(5분) 또는 운영 호출(`x-cron-secret`)
- **출력 테이블**: `public.dexscreener_market_update_queue`
- **체인 전략(현재)**
  - **항상**: Solana, Base
  - **회전(Round-Robin)**: `ethereum, bsc, arbitrum, polygon, avalanche, tron` 중 1개를 5분 버킷 기준으로 교대
  - (Intersection Rule) 위 8개 Allowlist 외 체인은 큐/DB 단계에서 차단됩니다.

#### 2) Market 스냅샷 적재(하이프 필터 포함)

- **함수**: `supabase/functions/fetch-dexscreener-market/index.ts`
- **역할**: `dexscreener_market_update_queue`를 drain하고, DexScreener 시장 데이터를 파싱해 `tokens`에 upsert합니다.
- **출력 테이블**: `public.tokens`
- **주요 컬럼(스냅샷)**
  - 가격/시장: `price_usd`, `volume_24h`, `liquidity_usd`, `fdv`, `market_cap`
  - 변동: `price_change_5m`, `price_change_15m`, `price_change_1h`
  - 메타: `symbol`, `logo_url`, `website_url`, `last_fetched_at`, `updated_at`
- **필터(저장 단계)**: 유동성/거래량이 낮은 후보는 저장 단계에서 드랍하여 DB를 lean하게 유지
  - `GOPLUS_PLAN_TIER=FREE`:
    - `liquidity_usd > 10,000`
    - `volume_24h > 50,000`
  - `GOPLUS_PLAN_TIER=PRO`:
    - `liquidity_usd > 2,000`
    - `volume_24h > 5,000`

#### 3) GoPlus 보안/품질 갱신(캐시 중심)

- **보안(토큰)**
  - **함수**: `supabase/functions/goplus-security-worker/index.ts`
  - **캐시**: `public.goplus_token_security_cache`
  - **저장 필드(핵심)**: `is_honeypot`, `buy_tax`, `sell_tax`, `trust_list`, `is_blacklisted` (+ raw)
  - **큐**: `public.token_security_scan_queue` (dequeue RPC 기반)
  - **비용 최적화(공통)**
    - **Scam Permanence**: `always_deny=true`(예: honeypot/blacklisted/전량매도불가/세금폭탄)로 확정된 토큰은 **영구 캐시** 처리되어 재스캔하지 않습니다.
    - **Dead Token Drop**: 시장 데이터가 24h 이상 업데이트되지 않고 `volume_24h=0/null`인 토큰은 캐시 만료 후에도 **재스캔 큐에서 영구 제외**합니다(최소 비용으로 노이즈 제거).
  - **FREE 모드 상한**
    - 워커 1회 실행 CU 예산: 100 (30분 크론 기준 하루 48회 → 이론상 4,800 CU/day 상한)
    - 일일 스캔 캡: 150 (캡 초과 시 다음날로 연기)

- **품질(URL/rugpull)**
  - **함수**: `supabase/functions/goplus-quality-worker/index.ts`
  - **캐시**: `public.goplus_url_risk_cache`, `public.goplus_rugpull_cache`
  - **큐**: `public.token_quality_scan_queue`
  - **FREE 모드**: CU 생존을 위해 워커가 **비활성화**됩니다(기존 캐시가 있으면 그대로 사용).

---

### 실시간 제공(프론트가 호출하는 API)

#### 1) Swipe Feed: `GET /functions/v1/get-feed`

- **함수**: `supabase/functions/get-feed/index.ts`
- **데이터 소스**
  - 후보: `public.dexswipe_get_feed(...)` RPC (anti-join + cursor pagination)
  - 실시간 병합:
    - DexScreener: `/tokens/v1/{chainId}/{tokenAddress1,tokenAddress2,...}`
    - GoPlus: token_security(체인별) batch
- **병합 방식**
  - 토큰 키: `token_id = "{chain_id}:{token_address}"`
  - Dex/Go 결과를 **Promise.all 병렬 호출** 후 단일 JSON로 합성
- **스캐닝 상태**
  - GoPlus 데이터가 없거나 실패 시 `goplus_status: scanning|unsupported`
  - 기본값은 “빈칸 방지”를 위해 **스캐닝 토큰도 반환**(필요 시 `include_scanning=false`)
- **Safety Score(감점제)**
  - 기본 100점에서 시작해 리스크 신호마다 감점합니다.
  - GoPlus 데이터가 누락/실패한 Unknown 상태는 **절대 100을 반환하지 않고** `50(Unknown)` 또는 `null`로 처리합니다.
  - 상세 사유는 `risk_factors: string[]`로 반환됩니다.
- **Seen 기록**
  - 응답으로 내려간 토큰은 `public.seen_tokens(user_device_id, token_id)`에 upsert되어 다음 피드에서 제외됩니다.
- **응답 타입**
  - `format=min`: **flat array** + 헤더 `x-next-cursor`
  - 숫자 필드들은 모두 **Number/null**로 반환(문자열 금지)

#### 2) Wishlist Live Sync: `GET /functions/v1/get-wishlist`

- **함수**: `supabase/functions/get-wishlist/index.ts`
- **동작**
  - DB에서 `public.wishlist`를 로드
  - 위시리스트 전량을 DexScreener에서 **매 호출마다 최신 가격으로 갱신**
  - GoPlus 보안도 병합하여 `goplus_*`를 함께 반환
- **프론트 ROI 계산**
  - 응답에 `captured_price`(저장 시점) + `current_price`(현재 시점) 포함
  - `roi_since_captured`도 함께 내려주지만, 프론트에서 재계산해도 무방

#### 3) Wishlist CRUD: `/functions/v1/wishlist`

- **함수**: `supabase/functions/wishlist/index.ts`
- **POST(캡처)**
  - 저장 시점 가격을 `captured_price`, 시각을 `captured_at`로 고정 기록
  - `tokens`에 스냅샷이 없으면 DexScreener를 1회 호출해 보정

---

### 스케줄(크론) 요약

- **`dexswipe_scheduled_fetch_every_5m`**: `*/5 * * * *` → `scheduled-fetch`
- **`dexscreener_market_every_15m`**: `*/15 * * * *` → `fetch-dexscreener-market`
- **`goplus_security_worker_every_30m`**: `*/30 * * * *` → `goplus-security-worker`
- **`goplus_quality_worker_every_2h`**: `0 */2 * * *` → `goplus-quality-worker`
- **`dexswipe_gc_tokens_daily_midnight_utc`**: `0 0 * * *` → 24h TTL(위시리스트 제외)
- **`dexswipe_cleanup_daily_430am_kst`**: 매일 04:30 KST(보조 정리/TTL)

---

### 주요 테이블(최종 사용)

- **Feed Snapshot**
  - `public.tokens` (transient, TTL 대상)
    - URL 분리 컬럼:
      - `dex_chart_url`: DexScreener 차트/스왑 링크(`pair.url`)
      - `official_website_url`: 공식 웹사이트(`info.websites[0].url`, 없으면 null)
      - `twitter_url`, `telegram_url`: `info.socials[]`에서 추출(없으면 null)
- **Personalization**
  - `public.seen_tokens` (device 기반 anti-join)
  - `public.wishlist` (persistent, captured_price/captured_at)
- **Ingestion / Queues**
  - `public.dexscreener_market_update_queue`
  - `public.token_security_scan_queue`
  - `public.token_quality_scan_queue`
- **Caches**
  - `public.goplus_token_security_cache`
  - `public.goplus_url_risk_cache`
  - `public.goplus_rugpull_cache`

---

### 환경변수/시크릿(운영 필수)

- **Supabase**
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` (서버/워커 전용)
- **Cron 인증**
  - `DEXSWIPE_CRON_SECRET` (Edge Functions 보호용 헤더 `x-cron-secret`)
- **외부 API**
  - `GOPLUS_API_KEY` (없으면 일부 호출이 제한될 수 있음)
- **플랜/비용 모드 스위치**
  - `GOPLUS_PLAN_TIER=FREE|PRO` (한 번 바꾸고 재시작하면 즉시 정책/임계값 전환)
    - FREE: HTTP API에서 GoPlus 라이브 호출 금지(캐시+큐 기반)
    - PRO: HTTP API에서 stale/missing에 대해 GoPlus 배치 라이브 병합 허용
- (선택) 고급 튜닝: `.env.example` 참고

---

### 운영 검증(1분 컷)

- `scripts/verify_pipeline.sh`
  - 크론 함수 1회씩 호출(수집 → 적재 → 스캔)
  - `get-feed(format=min)` 스키마/숫자 타입 자동 검증
  - wishlist 저장/조회/삭제 스모크 테스트

