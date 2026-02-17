## DexSwipe Backend (Supabase)

이 저장소는 **원격 Supabase(Postgres + Edge Functions)** 기반으로 DexScreener/GoPlus 데이터를 수집하고,
이를 바탕으로 DEX Swipe 백엔드 파이프라인을 구성합니다.

## 현재 구현 범위(요약)

- **수집(내부 작업)**
  - DexScreener: 최신 프로필/부스트/CTO(커뮤니티 테이크오버) 수집 → 원본 JSONB 저장
  - GoPlus: 토큰 보안 스캔(큐 + 워커) → 원본 JSONB + `always_deny` 정책 저장
- **서빙(프론트 사용 가능)**
  - `GET /functions/v1/get-feed`: 토큰 카드 리스트 반환(Always‑Deny 제외)
  - OpenAPI: `docs/openapi.yaml`
  - 프론트용 요약 문서: `docs/API.md`

## 원격 Supabase로 진행하기 (로컬 없이)

### 1) Supabase 프로젝트 생성 및 URL/키 확인

Supabase Dashboard에서 아래 값을 확인합니다.

- **Project URL**: `Project Settings > API > Project URL`
- **anon key (public)**: `Project Settings > API > Project API keys > anon public`
- **service_role key (secret)**: `Project Settings > API > Project API keys > service_role secret`
  - 서버에서만 사용하세요. 프론트/클라이언트에 절대 포함하면 안 됩니다.

### 2) 환경변수(.env) 설정

루트에 `.env`를 만들고 값을 채웁니다.

```bash
cp .env.example .env
```

필수:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

서버에서 관리자 권한이 필요할 때(주의):
- `SUPABASE_SERVICE_ROLE_KEY`

파이프라인 동작을 위해 추가로 필요:
- `DEXSWIPE_CRON_SECRET`
  - Edge Function이 `x-cron-secret`를 검증할 때 사용
  - DB 크론(pg_net)이 Edge Function을 호출할 때도 사용(Vault에 저장)

### 3) 간단 연결 테스트 (curl 기반)

이 저장소는 “핑” 대신, **실제 파이프라인을 한 번에 실행/검증**하는 스크립트를 제공합니다.

```bash
bash scripts/verify_pipeline.sh
```

이 스크립트는:
- DexScreener 수집 함수 3개 호출
- GoPlus 워커 1회 호출
- REST API로 테이블 row count 확인
까지 수행합니다.

## 원격에 스키마/함수 배포하기(Supabase CLI)

원격 프로젝트에 마이그레이션 반영:

```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

#### 비대화식(스크립트)로 푸시하기

원격 마이그레이션 푸시에는 **DB 비밀번호**가 필요합니다. `.env`에 아래 값을 채운 뒤 실행하세요.

- `SUPABASE_DB_PASSWORD`: 프로젝트 생성 시 설정한 DB 비밀번호(=postgres 비밀번호)

```bash
bash scripts/push_remote_migrations.sh
```

##### 비밀번호 오류(28P01)일 때 체크리스트

- `SUPABASE_DB_PASSWORD`는 **API Key(anon/service_role)**가 아니라 **프로젝트 DB 비밀번호**입니다.
- 비밀번호에 특수문자나 `#`가 들어있으면, `.env`에서 **반드시 따옴표로 감싸세요**.
  - 예: `SUPABASE_DB_PASSWORD='p@ssw0rd#123!'`

##### 대안: DATABASE_URL로 푸시하기(권장)

`.env`의 `DATABASE_URL`에 Dashboard에서 복사한 연결 문자열을 넣으면, 스크립트가 이를 사용해 푸시합니다.

- 경로: `Project Settings > Database > Connection string`

```bash
bash scripts/push_remote_migrations.sh
```

## 데이터 누적/정리 정책(자동)

현재는 아래 보관 정책으로 **자동 정리(삭제)**가 수행됩니다.

- `dexscreener_ingestion_runs`: **14일 보관**
- `token_security_scan_queue`: `completed` 기준 **7일 보관**
- `dexscreener_*_raw`(프로필/부스트/CTO): `updated_at` 기준 **30일 보관**
- `goplus_token_security_cache`: `scanned_at` 기준 **30일 보관**

정리 작업은 **매일 04:30 KST**에 1회 실행되도록 구성되어 있습니다.
(DB 크론은 매시간 체크하되, 함수 내부에서 KST 04:30일 때만 실행)

수동으로 결과를 확인하고 싶으면(서비스 롤 필요):

```bash
curl -sS -X POST \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  "$SUPABASE_URL/rest/v1/rpc/dexswipe_cleanup_daily_430am_kst" \
  -d '{}'
```

## DexScreener 수집(주기 실행, 릴리즈/무료티어 최적화)

### 목표

- DexScreener에서 “최신 후보 토큰”을 **가볍게 수집(enqueue)** 하고
- `tokens/v1`로 market 데이터를 가져와 **Hype Filter(유동성/트랜잭션)** 를 통과한 토큰만 `public.tokens`에 저장합니다.
- 원본(raw) JSONB 대량 저장은 제거하여 **500MB 무료 DB**에 맞춥니다.

### 저장 테이블

- `public.dexscreener_market_update_queue`: (chain_id, token_address) 단위 업데이트 작업 큐
- `public.tokens`: 릴리즈용 denormalized token 카드 데이터(필터 통과분만 저장)

### Edge Function

- `supabase/functions/scheduled-fetch`
  - DexScreener `token-profiles/latest/v1`를 호출해 **체인 라운드로빈**으로 후보 토큰을 큐에 넣습니다.
  - `DEXSWIPE_CRON_SECRET`가 설정되어 있으면 `x-cron-secret` 헤더가 일치할 때만 실행됩니다.
- `supabase/functions/fetch-dexscreener-market`
  - 큐를 drain하며 `tokens/v1`로 market을 가져오고, Hype Filter 통과분만 `public.tokens`에 upsert 합니다.

### 스케줄링(pg_cron + pg_net)

Supabase 공식 문서 권장 방식대로 `pg_cron` + `pg_net`로 Edge Function을 호출합니다.
관련 문서: [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)

스케줄은 무료 레이트리밋을 넘지 않는 선에서 아래처럼 구성되어 있습니다.
- scheduled-fetch(round-robin enqueue): 5분마다(함수 내부에서 분 단위 로테이션으로 skip 포함)
- market worker(tokens/v1): 5분마다
- GoPlus security worker: 30분마다
- GoPlus quality worker: 2시간마다

#### 필요한 Vault 시크릿

DB에서 Edge Function을 호출할 때 사용할 값들을 Vault에 넣어야 합니다.

- `project_url`: 예) `https://<project-ref>.supabase.co`
- `dexswipe_cron_secret`: `.env`의 `DEXSWIPE_CRON_SECRET`와 동일한 값

Vault에 추가(SQL 예시):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<DEXSWIPE_CRON_SECRET>', 'dexswipe_cron_secret');
```

### 수동 실행(즉시 한 번 돌려보기)

```bash
supabase functions deploy scheduled-fetch --no-verify-jwt
supabase functions deploy fetch-dexscreener-market --no-verify-jwt
curl -sS -X POST \
  -H "x-cron-secret: $DEXSWIPE_CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/scheduled-fetch"

curl -sS -X POST \
  -H "x-cron-secret: $DEXSWIPE_CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/fetch-dexscreener-market"
```

## GoPlus Security 연동(큐 + 워커)

### 개요

- `fetch-dexscreener-market`가 `tokens`를 upsert할 때, **지원 체인만** `token_security_scan_queue`에 스캔 작업을 적재합니다(Distribution).
- `goplus-security-worker`가 큐를 주기적으로 가져와(Processing) GoPlus API를 호출하고,
  결과를 `goplus_token_security_cache`에 저장합니다.
- **Always-Deny 원칙(치명 리스크 즉시 제외)**을 위해 `always_deny`, `deny_reasons`를 함께 저장합니다.
- 워커는 `token_security_scan_queue.next_run_at`이 지난 항목을 다시 가져와 **주기적으로 재스캔**합니다.
  - 성공 시 `last_scanned_at`이 갱신되고, 기본 재스캔 주기는 현재 **6시간**입니다(워커에서 설정).
  - 무료티어 최적화를 위해 `GOPLUS_CU_BUDGET_PER_RUN`으로 1회 실행당 처리량을 제한합니다.
  - 또한 품질/비용 최적화를 위해, **market 워커가 유동성/거래량 기준을 통과한 토큰만** `token_security_scan_queue`에 넣도록 게이트가 적용되어 있습니다.

## GoPlus 품질 신호(피싱/디앱/러그) 캐시

GoPlus 문서의 아래 API를 **저빈도 + 캐시(TTL)** 로 호출해 “링크/러그” 품질을 올립니다.
- Phishing Site Detection API: `GET /api/v1/phishing_site` ([문서](https://docs.gopluslabs.io/reference/phishing-site-detection-api))
- dApp Security Info API: `GET /api/v1/dapp_security` ([문서](https://docs.gopluslabs.io/reference/dapp-security-info-api))
- Rug-Pull Detection API (Beta): `GET /api/v1/rugpull_detecting/{chain_id}` ([문서](https://docs.gopluslabs.io/reference/api-overview))

구성 요소:
- 큐: `public.token_quality_scan_queue`
- 캐시:
  - `public.goplus_url_risk_cache` (url 단위)
  - `public.goplus_rugpull_cache` (chain/token 단위)
- 워커: `supabase/functions/goplus-quality-worker` (크론: 2시간마다)

`get-feed`는 기본적으로 **피싱(true) 또는 러그리스크(true)** 가 잡힌 토큰을 제외합니다.
필요하면 `include_risky=true`로 포함시킬 수 있습니다.

### 관련 테이블

- `public.chain_mappings`: DexScreener `chainId` → GoPlus 모드/체인 ID 매핑
  - 기본값: `solana`, `base(8453)`
- `public.token_security_scan_queue`: 스캔 작업 큐(중복 방지: PK `(chain_id, token_address)`)
- `public.goplus_token_security_cache`: GoPlus 원본(JSONB) + 추출 필드 + 정책(always_deny)

### GoPlus API 키 준비(외부 준비 사항)

GoPlus API가 인증을 요구하는 체인(EVM 등)이 있어, 운영을 위해서는 `GOPLUS_API_KEY`를
Edge Function 시크릿으로 등록하는 것을 권장합니다.

```bash
supabase secrets set GOPLUS_API_KEY="<YOUR_GOPLUS_API_KEY>" --yes
```

> 참고: Supabase CLI는 `SUPABASE_`로 시작하는 시크릿 이름을 예약 처리하여
> `supabase secrets set SUPABASE_URL=...` 같은 명령이 실패/스킵될 수 있습니다.
> 따라서 **우리가 추가로 넣어야 하는 시크릿은 `DEXSWIPE_CRON_SECRET`, `GOPLUS_API_KEY`** 입니다.

### 워커 수동 실행(테스트)

```bash
curl -sS -X POST \
  -H "x-cron-secret: $DEXSWIPE_CRON_SECRET" \
  "$SUPABASE_URL/functions/v1/goplus-security-worker?batch=20"
```

### 스케줄

- `pg_cron`이 **5분마다** `goplus-security-worker`를 호출합니다.
  - 호출에는 Vault 시크릿 `project_url`, `dexswipe_cron_secret`가 필요합니다.

## “apikey / accesskey”를 어디에 넣나요?

### Supabase API Key (일반적으로 말하는 apikey)

- **`SUPABASE_ANON_KEY`**
  - 공개키(anon)입니다.
  - 백엔드에서도 “사용자 권한(RLS 포함)”으로 동작시키고 싶을 때 사용합니다.
  - 요청 헤더로는 보통 아래처럼 들어갑니다.
    - `apikey: <anon key>`
    - `Authorization: Bearer <anon key 또는 사용자 access token>`

- **`SUPABASE_SERVICE_ROLE_KEY`**
  - 비밀키(service_role)입니다.
  - 서버에서만 사용하세요. RLS를 우회할 수 있습니다.
  - 보통 “서버 내부 배치/관리 API” 같은 곳에서만 사용합니다.

### access key (보통 두 가지 의미 중 하나)

1) **사용자 Access Token (JWT)**
   - Supabase Auth 로그인 후 클라이언트가 받는 토큰입니다.
   - API 호출 시 `Authorization: Bearer <access_token>` 으로 넣습니다.
   - 이 토큰은 `.env`에 고정값으로 넣기보다는 “로그인 후 동적으로” 다룹니다.

2) **S3 Access Key / Secret Key (스토리지 S3 호환 프로토콜)**
   - `supabase/config.toml`의 아래 항목이 이를 가리킵니다.
   - `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_HOST`, `S3_REGION`
   - 로컬/ETL/외부 S3 호환 클라이언트로 접근할 때 쓰는 값이며, 보안상 비밀로 관리해야 합니다.
   - `supabase/.env`로도 관리할 수 있도록 `supabase/.env.example`를 제공했습니다.

## Supabase CLI로 원격 프로젝트에 “연결/배포(스키마 반영)”하기

이 저장소는 **원격 Supabase를 기준으로 마이그레이션을 관리**합니다. 현재는 최소 동작 확인용으로 `public.ping()`를 만드는
마이그레이션이 포함되어 있습니다.

```bash
# 1) 로그인 (브라우저 인증)
supabase login

# 2) 원격 프로젝트와 링크
# project ref는 Dashboard의 project settings 등에 표시됩니다.
supabase link --project-ref <YOUR_PROJECT_REF>

# 3) 마이그레이션이 생기면 원격에 반영
supabase db push
```

## 외부 준비 사항 체크리스트(운영/비용/법적)

- **DexScreener**
  - 무료/상업용 사용 조건 및 레이트리밋 확인 (공식 API 레퍼런스: [DEX Screener API Reference](https://docs.dexscreener.com/api/reference))
  - 대규모 트래픽/상업적 사용 시 별도 계약 필요 가능성

- **GoPlus Security**
  - EVM 체인 등에서 안정적으로 사용하려면 `GOPLUS_API_KEY` 준비 및 Supabase Secrets 등록
  - CU(Compute Unit) 과금/레이트리밋 정책에 따라 워커 배치 크기/주기 조정 필요

- **Supabase 플랜/비용**
  - Edge Functions 호출량, DB/스토리지 사용량 모니터링
  - 이미지 변환(imgproxy) 비용 정책 확인(원본 이미지 수 기반 과금 가능)

- **법적/운영 고지**
  - 투자 조언이 아닌 정보 제공 도구임을 명시(면책조항)
  - “Powered by DexScreener”, “Security Data by GoPlus” 등 출처/상표 가이드 준수 필요

---

## Frontend에서 사용하는 방법

### 1) 프론트에 넣어도 되는 값 / 넣으면 안 되는 값

- **프론트에 넣어도 됨**
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY` (publishable/anon)
- **프론트에 절대 넣으면 안 됨**
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `DEXSWIPE_CRON_SECRET`
  - `SUPABASE_DB_PASSWORD`
  - `GOPLUS_API_KEY`

### 2) 피드 조회 API (현재 프론트에서 바로 사용 가능)

- **Endpoint**: `GET ${SUPABASE_URL}/functions/v1/get-feed`
- **Query**
  - `limit` (기본 30, 최대 100)
  - `offset` (기본 0)
  - `chains` (예: `solana,base`)
  - `min_liquidity_usd` (선택) 최소 유동성(USD)
  - `min_volume_24h` (선택) 24h 거래량 최소값(USD)
  - `min_fdv` (선택) FDV 최소값(USD)
- **응답(요약)**
  - `tokens[]`:
    - `chain_id`, `token_address`, `fetched_at`
    - `profile`: DexScreener `/token-profiles/latest/v1` 원본 객체
    - `boost`: DexScreener `/token-boosts/latest/v1` 원본 객체(없으면 null)
    - `takeover`: DexScreener `/community-takeovers/latest/v1` 원본 객체(없으면 null)
    - `market`: `tokens/v1` 기반 시장 데이터 요약 + `raw_best_pair`
    - `security`: GoPlus 캐시 요약(없으면 null)

#### curl 예시

```bash
curl -sS "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base"
```

유동성 필터 예시:

```bash
curl -sS "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&min_liquidity_usd=10000"
```

#### supabase-js(프론트) 예시

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// Edge Function 호출(프론트에서 사용 가능)
const { data, error } = await supabase.functions.invoke("get-feed", {
  method: "GET",
  // supabase-js는 querystring을 직접 붙이는 형태가 가장 단순합니다.
  // (또는 fetch로 ${SUPABASE_URL}/functions/v1/get-feed?... 호출)
});
```

> 참고: `get-feed`는 현재 `--no-verify-jwt`로 배포되어 있어 인증 없이 호출됩니다.
> 운영 단계에서는 사용자 JWT 기반으로 제한하거나(verify_jwt=true), 레이트리밋/캐싱을 추가하는 것을 권장합니다.

### 내가 직접 확인하는 방법(요약)

1) `.env` 준비
- `.env.example`를 복사해서 아래 값 채우기
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEXSWIPE_CRON_SECRET`, `SUPABASE_DB_PASSWORD`

2) (원격) Edge Function 시크릿 등록
- `DEXSWIPE_CRON_SECRET` (필수)
- `GOPLUS_API_KEY` (권장)

```bash
supabase secrets set DEXSWIPE_CRON_SECRET="$DEXSWIPE_CRON_SECRET" --yes
supabase secrets set GOPLUS_API_KEY="<YOUR_GOPLUS_API_KEY>" --yes
```

3) 배포/반영
- `bash scripts/push_remote_migrations.sh`
- `supabase functions deploy scheduled-fetch --no-verify-jwt --use-api --yes`
- `supabase functions deploy fetch-dexscreener-market --no-verify-jwt --use-api --yes`
- `supabase functions deploy get-feed --no-verify-jwt --use-api --yes`
- `supabase functions deploy goplus-security-worker --no-verify-jwt --use-api --yes`
- `supabase functions deploy goplus-quality-worker --no-verify-jwt --use-api --yes`

4) 검증(원클릭)
- `bash scripts/verify_pipeline.sh`

## API 문서(프론트)

- `docs/API.md`
- `docs/openapi.yaml`
