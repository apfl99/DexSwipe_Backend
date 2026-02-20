## DexSwipe Backend API (Frontend)

### Base URL

- `SUPABASE_URL` 예: `https://<project-ref>.supabase.co`

### Public API

#### `GET /functions/v1/get-feed`

토큰 카드 피드 조회 API.

- **지원 체인(Intersection Rule)**  
  DexScreener는 매우 많은 체인을 지원하지만, DexSwipe는 **GoPlus Security로 검증 가능한 체인만** 적재/노출합니다.
  - Allowlist: `solana, base, bsc, ethereum, arbitrum, polygon, avalanche, tron`
  - 위 리스트에 없는 체인(예: `sui`, `aptos`, `ton`)은 **적재 단계에서 즉시 드롭**되며, `chains=`로 요청해도 결과는 비어있습니다.

- **Headers**
  - `x-client-id`: 클라이언트/디바이스 식별자(필수). seen 제외(anti-join)에 사용됩니다.

- **Query**
  - `format`: `full|min` (기본 `full`)
  - `limit`: 1~20 (기본 20, 실시간 병합 비용 제한)
  - `cursor`: ISO timestamp (선택). `updated_at < cursor` 범위를 가져옵니다.
  - `chains`: `solana,base` 형태 (지원 체인만 허용)
  - `min_liquidity_usd`: 최소 유동성(USD)
  - `min_volume_24h`: 24h 거래량 최소값(USD)
  - `min_fdv`: FDV 최소값(USD)
  - `include_risky`: `true`면 피싱/러그 위험 자산도 포함(기본 false)
  - `allow_repeat`: `true`면 이미 본 토큰(seen_tokens)을 다시 피드에 포함(기본 false, 토글용)
  - `include_scanning`: `true|false` (기본 `true`)  
    - Checks가 아직 완료되지 않으면 `checks_state=pending|limited`로 내려올 수 있습니다(체인 미지원은 `unsupported`).

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
`format=full`일 때는 응답이 다음 형태입니다.

```json
{ "tokens": [ /* FeedItemFull[] */ ] }
```
응답은 DexScreener(가격) + GoPlus(보안)를 병렬로 합친 “완전체”를 목표로 하며, 주요 필드:
- DexScreener: `price_usd`, `volume_24h`, `liquidity_usd`, `fdv`, `price_change_5m`, `price_change_1h`
- GoPlus: `goplus_is_honeypot`, `goplus_buy_tax`, `goplus_sell_tax`, `goplus_trust_list`, `goplus_is_blacklisted`, `goplus_status`
- Intelligence: `safety_score(0~100)`, `is_surging`
이미지(로고):
- `logo_url`은 DexScreener가 아이콘을 제공하지 않는 토큰의 경우 **null**일 수 있습니다. (백엔드에서는 `tokens/v1`의 `info.imageUrl` + `token-profiles`의 `icon`을 best-effort로 사용)
- 프론트에서는 `logo_url == null`이면 **체인 아이콘/기본 placeholder**로 fallback 렌더링을 권장합니다.
URL 분리:
- `dex_chart_url`: DexScreener 차트/스왑 링크(`pair.url`)
- `official_website_url`: 공식 웹사이트(`info.websites[0].url`, 없으면 null)
- `twitter_url`, `telegram_url`: `info.socials[]`에서 추출(없으면 null)
추가로, 프론트에서 위험 사유를 바로 표시할 수 있도록 `risk_factors: string[]`가 포함됩니다(감점제 산정 결과).
Checks(완성도):
- `checks_state`: `pending|complete|limited|unsupported`
  - `pending`: 검사 대기/진행 중
  - `complete`: 검사 데이터 충분(상태 안정)
  - `limited`: 점수는 산출했지만 상세 체크 일부 누락
  - `unsupported`: 체인 미지원
스캔 대상:
- `tokens` 테이블에 저장된(=수집 품질 필터를 통과한) 토큰은 **전부** 보안/품질 스캔 큐에 enqueue 됩니다. (유동성/거래량 기반의 별도 제한 없음)
Score 표기:
- GoPlus 검증이 **완료(complete)** 되지 않은 상태(`pending|limited|unsupported`)에서는 `safety_score`는 **null**로 내려오며,
  프론트에서는 **`"-"`(미표기)** 로 렌더링하는 것을 권장합니다.
  - 사유는 `risk_factors`로 내려옵니다. (예: `["Checks Pending"]`, `["Checks Limited (provider fields missing)"]`)
  - 동일하게 `goplus_*` 상세 플래그들도 **검증 완료 전에는 전부 null**로 내려옵니다. (프론트는 null을 “미확정/미검증”으로 해석)
`risk_factors`가 “왜 limited인지”를 명확히 설명하도록 설계되어 있으며, 대표 예시는 아래와 같습니다.
- `Checks Pending`
- `Checks Limited (GoPlus code 7013: Address format error!)`
- `Checks Limited (GoPlus code 7012: Not fungible spl token address)`

GoPlus(체인별 신호 매핑):
- EVM(Base 등): `is_honeypot`, `is_blacklisted`, `cannot_sell_all`, `buy_tax`, `sell_tax`, `is_proxy` 등 EVM 표준 필드를 직접 사용합니다.
- Solana: GoPlus Solana Token Security 응답의 `status` 기반 신호를 감점제에 매핑합니다.
  - Solana 주소는 **대소문자 민감(case-sensitive)** 이므로, 백엔드는 token_address를 소문자 변환하지 않습니다.
  - `mintable.status=1` → `Mintable`(저위험 -5)
  - `freezable.status=1` → `Transfer Pausable`(고위험 -20)
  - `metadata_mutable.status=1` → `Take Back Ownership`(저위험 -5)
  - `non_transferable.status=1` → `Cannot Sell All`(치명 - 즉시 0점)
프론트 렌더링 권장(혼선 방지):
- **표시 우선순위**: `checks_state`를 1순위로 사용하고, `goplus_status`는 디버그/보조 텍스트로만 사용합니다.
- **라벨 매핑(예시)**:
  - `pending` → `PENDING`
  - `limited` → `LIMITED`
  - `complete` → `COMPLETE`
  - `unsupported` → `UNSUPPORTED`
Txns(활동 지표):
- `txns_24h`: 24h 거래 횟수(가능하면 `buys_24h+sells_24h` 기반)

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
  - `safety_score`는 **감점제(Deduction Model)**로 산정되며, 데이터 누락/실패 시 **100을 절대 반환하지 않고** `50(Unknown)` 또는 `null`로 처리합니다.
  - 상세 사유는 `risk_factors: string[]`로 내려옵니다.
  - URL 분리 필드(`dex_chart_url`, `official_website_url`, `twitter_url`, `telegram_url`) 및 `urls` 객체가 함께 내려옵니다.
  - `checks_state`를 함께 내려 프론트에서 “Checks LIMITED/COMPLETE” 등을 안정적으로 표시할 수 있습니다.
  - `risk_factors`에 `Checks Limited (GoPlus code ...: ...)` 형태의 구체 사유가 포함될 수 있습니다(예: 주소 포맷 오류, 비지원 토큰 타입 등).

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

