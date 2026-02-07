# DexSwipe Backend (Remote Supabase)

이 저장소는 Supabase를 기반으로 백엔드를 구성하기 위한 토대입니다. 현재는 `supabase/`(Supabase CLI 프로젝트)만 존재하며,
**로컬 Supabase를 띄우지 않고도(=원격 Supabase만으로) 빠르게 연결 테스트**할 수 있도록 최소 설정 파일을 포함합니다.

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

### 3) 간단 연결 테스트 (curl 기반)

```bash
bash scripts/test_remote_supabase.sh
```

정상이라면:
- `auth/v1/health` 응답이 오고
- `rest/v1/` OpenAPI 일부 JSON이 출력됩니다(일반적으로 **secret key 필요**)
- (추가) DB 마이그레이션을 적용했다면 `rpc/ping`에서 `pong`이 출력됩니다.

## DB가 아직 “없는” 상태라면(원격 프로젝트/인스턴스 생성 전)

Supabase는 **프로젝트를 생성하는 순간 원격 Postgres(DB 인스턴스)가 함께 생성**됩니다. 즉 “DB가 없음”은 보통 아래 중 하나입니다.

- **(A) Supabase 프로젝트 자체를 아직 생성하지 않음**
  - Dashboard에서 프로젝트를 먼저 만들고 `SUPABASE_URL`, `SUPABASE_ANON_KEY`를 받아야 합니다.
- **(B) 프로젝트는 있는데 테이블/함수(스키마)가 없음**
  - 이 경우 “마이그레이션”을 원격으로 푸시하면 됩니다.

### 원격에 최소 스키마 푸시하기 (rpc/ping 포함)

이 저장소에는 테스트용으로 `public.ping()` 함수를 만드는 마이그레이션이 포함돼 있습니다:
- `supabase/migrations/20260207000000_init_ping.sql`

원격 프로젝트에 반영:

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

## DB 반영 확인(가장 간단한 체크)

이 저장소는 원격 DB에 `public.ping()` RPC 함수를 올려두고, 이를 호출해 DB/REST 계층이 정상인지 확인합니다.

```bash
bash scripts/test_remote_supabase.sh
```

정상이라면 마지막에 아래가 출력됩니다.
- `"pong"`

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

# DexSwipe_Backend
