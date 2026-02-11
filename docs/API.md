## DexSwipe Backend API (Frontend)

### Base URL

- `SUPABASE_URL` 예: `https://<project-ref>.supabase.co`

### Public API

#### `GET /functions/v1/get-feed`

토큰 카드 피드 조회 API.

- **Query**
  - `limit`: 1~100 (기본 30)
  - `offset`: 0 이상 (기본 0)
  - `chains`: `solana,base` 형태
  - `min_liquidity_usd`: 최소 유동성(USD)
  - `min_volume_24h`: 24h 거래량 최소값(USD)
  - `min_fdv`: FDV 최소값(USD)
  - `include_risky`: `true`면 피싱/러그 위험 자산도 포함(기본 false)

- **리스크 필터(기본 동작)**
  - `security.always_deny=true` 이면 제외
  - `quality.url_risk.is_phishing=true` 이면 제외
  - `quality.rugpull.is_rugpull_risk=true` 이면 제외

- **예시**

```bash
curl -sS "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&min_liquidity_usd=10000"
```

위험 자산도 포함해서 확인(운영/디버그용):

```bash
curl -sS "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&include_risky=true"
```

### OpenAPI

- 스펙 파일: `docs/openapi.yaml`

