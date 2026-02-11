#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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
require_env SUPABASE_SERVICE_ROLE_KEY
require_env DEXSWIPE_CRON_SECRET

SUPABASE_URL="${SUPABASE_URL%/}"

echo "== DexSwipe pipeline verification =="
echo "- SUPABASE_URL: ${SUPABASE_URL}"
echo

echo "1) Invoke DexScreener ingest functions (manual once)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-latest" | sed 's/.*/  &/'
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-boosts" | sed 's/.*/  &/'
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-boosts-top" | sed 's/.*/  &/'
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-takeovers" | sed 's/.*/  &/'
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-market" | sed 's/.*/  &/'
echo

echo "2) Invoke GoPlus worker once (drain queue)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/goplus-security-worker?batch=20" \
  | sed -n '1,25p' | sed 's/.*/  &/'
echo

echo "2.5) Invoke GoPlus quality worker once (URL/rugpull cache)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/goplus-quality-worker" \
  | sed -n '1,25p' | sed 's/.*/  &/'
echo

echo "3) Verify DB row counts (service role via REST)"
authH=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")
echo -n "  dexscreener_token_profiles_raw: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/dexscreener_token_profiles_raw"
echo
echo -n "  dexscreener_token_boosts_raw: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/dexscreener_token_boosts_raw"
echo
echo -n "  dexscreener_community_takeovers_raw: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/dexscreener_community_takeovers_raw"
echo
echo -n "  token_security_scan_queue (pending): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  --data-urlencode "status=eq.pending" \
  "${SUPABASE_URL}/rest/v1/token_security_scan_queue"
echo
echo -n "  goplus_token_security_cache: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/goplus_token_security_cache"
echo
echo -n "  dexscreener_token_boosts_top_raw: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/dexscreener_token_boosts_top_raw"
echo

echo -n "  dexscreener_token_market_data: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/dexscreener_token_market_data"
echo

echo -n "  token_quality_scan_queue: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/token_quality_scan_queue"
echo
echo -n "  goplus_url_risk_cache: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/goplus_url_risk_cache"
echo
echo -n "  goplus_rugpull_cache: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/goplus_rugpull_cache"
echo

echo -n "  edge_function_heartbeats: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/edge_function_heartbeats"
echo
echo

echo "4) Smoke: call public get-feed"
curl -sS "${SUPABASE_URL}/functions/v1/get-feed?limit=3&chains=solana,base" | sed -n '1,5p' | sed 's/.*/  &/'
echo

echo "Done."

