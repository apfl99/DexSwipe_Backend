## DexSwipe Backend API (Frontend)

### Base URL

- `SUPABASE_URL` 예: `https://<project-ref>.supabase.co`

### Public API

#### `GET /functions/v1/get-feed`

토큰 카드 피드 조회 API.

- **Headers**
  - `x-client-id`: 클라이언트/디바이스 식별자(필수). seen 제외(anti-join)에 사용됩니다.

- **Query**
  - `format`: `full|min` (기본 `full`)
  - `limit`: 1~20 (기본 20, 실시간 병합 비용 제한)
  - `cursor`: ISO timestamp (선택). `updated_at < cursor` 범위를 가져옵니다.
  - `chains`: `solana,base` 형태
  - `min_liquidity_usd`: 최소 유동성(USD)
  - `min_volume_24h`: 24h 거래량 최소값(USD)
  - `min_fdv`: FDV 최소값(USD)
  - `include_risky`: `true`면 피싱/러그 위험 자산도 포함(기본 false)
  - `include_scanning`: `true|false` (기본 `true`)  
    - GoPlus 보안 데이터가 아직 없거나 호출 실패 시 `goplus_status=scanning|unsupported`로 내려옵니다.

- **리스크 필터(기본 동작)**
  - `security.always_deny=true` 이면 제외
  - `quality.url_risk.is_phishing=true` 이면 제외
  - `quality.rugpull.is_rugpull_risk=true` 이면 제외

- **예시**

```bash
curl -sS -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&min_liquidity_usd=10000"
```

초경량(min) 모드:

```bash
curl -sS -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&format=min" \
  -D - | head -n 30
```

`format=min`일 때는 응답이 **flat JSON array**이고, 다음 페이지 커서는 응답 헤더 `x-next-cursor`로 내려옵니다.
응답은 DexScreener(가격) + GoPlus(보안)를 병렬로 합친 “완전체”를 목표로 하며, 주요 필드:
- DexScreener: `price_usd`, `volume_24h`, `liquidity_usd`, `fdv`, `price_change_5m`, `price_change_1h`
- GoPlus: `goplus_is_honeypot`, `goplus_buy_tax`, `goplus_sell_tax`, `goplus_trust_list`, `goplus_is_blacklisted`, `goplus_status`
- Intelligence: `safety_score(0~100)`, `is_surging`

위험 자산도 포함해서 확인(운영/디버그용):

```bash
curl -sS -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/get-feed?limit=20&chains=solana,base&include_risky=true"
```

#### `GET /functions/v1/wishlist`

디바이스(= `x-client-id`) 기준 위시리스트 조회.

- **Headers**
  - `x-client-id`: 필수
- **Query**
  - `limit`: 1~200 (기본 100)

```bash
curl -sS -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/wishlist?limit=50"
```

#### `GET /functions/v1/get-wishlist`

위시리스트 ROI 조회(= “헌터 트래킹 엔진”).

- **특징**
  - **Live-Sync**: 호출 시마다 위시리스트 토큰 전체를 DexScreener에서 최신 가격으로 갱신합니다.
  - `captured_price`(저장 시점) + `current_price`(현재 시점)를 함께 반환합니다.
  - `roi_since_captured`도 함께 내려주지만, 프론트에서 즉시 재계산해도 됩니다.
  - GoPlus 보안 필드도 병합하여 반환합니다(`goplus_*`).

- **Headers**
  - `x-client-id`: 필수
- **Query**
  - `limit`: 1~200 (기본 100)

```bash
curl -sS -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/get-wishlist?limit=50"
```

#### `POST /functions/v1/wishlist`

위시리스트 추가.

```bash
curl -sS -X POST -H "x-client-id: device-abc" -H "Content-Type: application/json" \
  -d '{"token_id":"solana:So11111111111111111111111111111111111111112"}' \
  "$SUPABASE_URL/functions/v1/wishlist"
```

> 저장 시점에 `captured_price`, `captured_at`이 DB에 고정 기록됩니다(토큰 스냅샷이 없으면 DexScreener에서 1회 조회).

#### `DELETE /functions/v1/wishlist?token_id=...`

위시리스트 삭제.

```bash
curl -sS -X DELETE -H "x-client-id: device-abc" \
  "$SUPABASE_URL/functions/v1/wishlist?token_id=solana:So11111111111111111111111111111111111111112"
```

### OpenAPI

- 스펙 파일: `docs/openapi.yaml`

