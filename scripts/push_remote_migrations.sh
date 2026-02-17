#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Load .env safely (no shell expansion) if present
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/dotenv.sh"
dotenv_load "${SCRIPT_DIR}/../.env"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing env: $name" >&2
    exit 1
  fi
}

build_pooler_db_url() {
  # Build a db connection string targeting Supabase pooler, with password inserted.
  # Input from supabase/.temp/pooler-url looks like:
  #   postgresql://postgres.<ref>@aws-...pooler.supabase.com:5432/postgres
  python3 - <<'PY'
import os, urllib.parse
pooler = os.environ.get("POOLER_URL", "")
password = os.environ.get("SUPABASE_DB_PASSWORD", "")
if not pooler:
  raise SystemExit("missing POOLER_URL")
u = urllib.parse.urlsplit(pooler)
user = u.username or ""
host = u.hostname or ""
port = u.port or 5432
db = (u.path or "/postgres").lstrip("/") or "postgres"
q = urllib.parse.parse_qs(u.query)
q.setdefault("sslmode", ["require"])
query = urllib.parse.urlencode({k:v[0] for k,v in q.items()})
# NOTE: urlunsplit will percent-encode the password as needed when we build netloc manually.
netloc = f"{user}:{urllib.parse.quote(password, safe='')}@{host}:{port}"
print(urllib.parse.urlunsplit((u.scheme or "postgresql", netloc, "/" + db, query, "")))
PY
}

normalize_db_url() {
  # Ensure password is URL-encoded and sslmode=require is set.
  # Returns a raw DSN string suitable for supabase --db-url.
  python3 - <<'PY'
import os, urllib.parse
raw = os.environ.get("RAW_DB_URL", "")
if not raw:
  raise SystemExit("missing RAW_DB_URL")
u = urllib.parse.urlsplit(raw)
scheme = u.scheme or "postgresql"
user = u.username or ""
password = u.password or ""
host = u.hostname or ""
port = u.port or 5432
db = (u.path or "/postgres").lstrip("/") or "postgres"
q = urllib.parse.parse_qs(u.query)
q.setdefault("sslmode", ["require"])
query = urllib.parse.urlencode({k:v[0] for k,v in q.items()})
netloc = f"{user}:{urllib.parse.quote(password, safe='')}@{host}:{port}"
print(urllib.parse.urlunsplit((scheme, netloc, "/" + db, query, "")))
PY
}

PROJECT_REF_FILE="supabase/.temp/project-ref"

if [[ ! -f "${PROJECT_REF_FILE}" ]]; then
  echo "Missing ${PROJECT_REF_FILE}. Run 'supabase link --project-ref <ref>' once." >&2
  exit 1
fi

PROJECT_REF="$(cat "${PROJECT_REF_FILE}")"
PROJECT_REF="${PROJECT_REF//$'\r'/}"
PROJECT_REF="${PROJECT_REF//$'\n'/}"

if [[ -z "${PROJECT_REF}" ]]; then
  echo "Empty project ref in ${PROJECT_REF_FILE}" >&2
  exit 1
fi

echo "== Push migrations to remote =="
echo "- Project ref: ${PROJECT_REF}"
echo

echo "1) Ensure logged in"
if ! supabase projects list >/dev/null 2>&1; then
  echo "Not logged in. Run: supabase login" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "2) Push migrations using DATABASE_URL (no link required)"
  export RAW_DB_URL="${DATABASE_URL}"
  DB_URL="$(normalize_db_url)"

  set +e
  DBURL_OUT="$(
    printf 'y\n' | supabase db push --db-url "${DB_URL}" --yes 2>&1
  )"
  DBURL_CODE="$?"
  set -e

  if [[ "${DBURL_CODE}" -eq 0 ]]; then
    echo "Done."
    exit 0
  fi

  echo "${DBURL_OUT}" >&2
  echo >&2
  echo "DATABASE_URL push failed; falling back to password/pooler method..." >&2
fi

require_env SUPABASE_DB_PASSWORD

echo "2) Link project (non-interactive)"
supabase link --project-ref "${PROJECT_REF}" --password "${SUPABASE_DB_PASSWORD}" --yes

echo "3) Push migrations"
  set +e
  PUSH_OUT="$(
    printf 'y\n' | supabase db push --password "${SUPABASE_DB_PASSWORD}" --yes 2>&1
  )"
  PUSH_CODE="$?"
  set -e

  if [[ "${PUSH_CODE}" -ne 0 ]]; then
    echo "${PUSH_OUT}" >&2
    echo >&2
    echo "Push failed; trying pooler db-url fallback..." >&2

    POOLER_FILE="supabase/.temp/pooler-url"
    if [[ -f "${POOLER_FILE}" ]]; then
      export POOLER_URL
      POOLER_URL="$(cat "${POOLER_FILE}")"
      POOLER_URL="${POOLER_URL//$'\r'/}"
      POOLER_URL="${POOLER_URL//$'\n'/}"

      RAW_DB_URL="$(build_pooler_db_url)"
      export RAW_DB_URL
      DB_URL="$(normalize_db_url)"

      set +e
      POOL_OUT="$(
        printf 'y\n' | supabase db push --db-url "${DB_URL}" --yes 2>&1
      )"
      POOL_CODE="$?"
      set -e

      if [[ "${POOL_CODE}" -ne 0 ]]; then
        echo "${POOL_OUT}" >&2
        echo >&2
        echo "Push failed." >&2
        echo "- If you see 'password authentication failed', ensure SUPABASE_DB_PASSWORD is the project's DB password (not an API key)." >&2
        echo "- If the password contains special characters or '#', wrap it in single quotes in .env." >&2
        echo "- Alternatively, set DATABASE_URL (Project Settings > Database > Connection string) and rerun." >&2
        exit "${POOL_CODE}"
      fi
    else
      echo "Missing ${POOLER_FILE}; cannot use pooler fallback." >&2
      echo "- If you see 'password authentication failed', ensure SUPABASE_DB_PASSWORD is the project's DB password (not an API key)." >&2
      echo "- Alternatively, set DATABASE_URL (Project Settings > Database > Connection string) and rerun." >&2
      exit "${PUSH_CODE}"
    fi
  fi

echo "Done."

