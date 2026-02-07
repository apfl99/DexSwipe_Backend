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

require_env SUPABASE_URL
require_env SUPABASE_ANON_KEY

SUPABASE_URL="${SUPABASE_URL%/}"

echo "== Supabase remote smoke test =="
echo "- SUPABASE_URL: ${SUPABASE_URL}"
echo

echo "1) Auth health (requires apikey header)"
curl -sS \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  "${SUPABASE_URL}/auth/v1/health" \
  | sed 's/.*/  &/'
echo

echo "2) REST OpenAPI (requires secret key)"
echo "   (Schema/OpenAPI access via Data API typically requires a secret key.)"
if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "  (skip) SUPABASE_SERVICE_ROLE_KEY not set."
else
  curl -sS \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Accept: application/openapi+json" \
    "${SUPABASE_URL}/rest/v1/" \
    | sed -n '1,20p' \
    | sed 's/.*/  &/'
fi
echo

echo "3) RPC ping() (requires migration applied)"
echo "   POST /rest/v1/rpc/ping should return pong"
set +e
PING_STATUS="$(
  curl -sS -o /tmp/supabase_ping_body.$$ -w "%{http_code}" \
    -X POST \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    "${SUPABASE_URL}/rest/v1/rpc/ping" \
    -d '{}'
)"
set -e

if [[ "${PING_STATUS}" == "200" ]]; then
  sed 's/.*/  &/' /tmp/supabase_ping_body.$$
else
  echo "  (skip) ping not ready yet (HTTP ${PING_STATUS})."
  if [[ "${PING_STATUS}" == "404" && -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
    echo "  Attempting to push migrations (SUPABASE_DB_PASSWORD is set)..."
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    bash "${SCRIPT_DIR}/push_remote_migrations.sh"
    echo "  Retrying ping..."
    curl -sS \
      -X POST \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
      -H "Content-Type: application/json" \
      "${SUPABASE_URL}/rest/v1/rpc/ping" \
      -d '{}' \
      | sed 's/.*/  &/'
  else
    echo "  Apply migration: supabase link --project-ref <ref> && supabase db push"
    echo "  (Tip) Set SUPABASE_DB_PASSWORD in .env to use scripts/push_remote_migrations.sh"
  fi
fi
rm -f /tmp/supabase_ping_body.$$
echo

echo "Done."

