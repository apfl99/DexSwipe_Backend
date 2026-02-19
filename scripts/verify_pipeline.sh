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

echo "1) Invoke scheduled-fetch (round-robin enqueue)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/scheduled-fetch" | sed 's/.*/  &/'
echo

echo "2) Invoke market worker once (populate tokens)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/fetch-dexscreener-market" | sed -n '1,3p' | sed 's/.*/  &/'
echo

echo "3) Invoke GoPlus security worker once"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/goplus-security-worker?batch=20" \
  | sed -n '1,25p' | sed 's/.*/  &/'
echo

echo "4) Invoke GoPlus quality worker once (URL/rugpull cache)"
curl -sS -X POST -H "x-cron-secret: ${DEXSWIPE_CRON_SECRET}" \
  "${SUPABASE_URL}/functions/v1/goplus-quality-worker" \
  | sed -n '1,25p' | sed 's/.*/  &/'
echo

echo "5) Verify DB row counts (service role via REST)"
authH=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")
echo -n "  token_security_scan_queue (pending): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  --data-urlencode "status=eq.pending" \
  "${SUPABASE_URL}/rest/v1/token_security_scan_queue"
echo
echo -n "  goplus_token_security_cache: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/goplus_token_security_cache"
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
echo -n "  tokens: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/tokens"
echo
echo -n "  market_update_queue(sol): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" --data-urlencode "chain_id=eq.solana" \
  "${SUPABASE_URL}/rest/v1/dexscreener_market_update_queue"
echo
echo -n "  market_update_queue(base): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" --data-urlencode "chain_id=eq.base" \
  "${SUPABASE_URL}/rest/v1/dexscreener_market_update_queue"
echo
echo -n "  market_update_queue(sui): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" --data-urlencode "chain_id=eq.sui" \
  "${SUPABASE_URL}/rest/v1/dexscreener_market_update_queue"
echo
echo -n "  market_update_queue(tron): "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" --data-urlencode "chain_id=eq.tron" \
  "${SUPABASE_URL}/rest/v1/dexscreener_market_update_queue"
echo

echo -n "  edge_function_heartbeats: "
curl -sS -G "${authH[@]}" --data-urlencode "select=count" \
  "${SUPABASE_URL}/rest/v1/edge_function_heartbeats"
echo
echo

echo "6) Smoke: call get-feed format=min (requires x-client-id)"
tmpdir="$(mktemp -d)"
hdr="${tmpdir}/headers.txt"
body="${tmpdir}/body.json"
curl -sS -D "${hdr}" -o "${body}" -H "x-client-id: verify-rc" \
  "${SUPABASE_URL}/functions/v1/get-feed?limit=2&chains=solana,base&format=min"
echo "  x-next-cursor: $(awk 'BEGIN{IGNORECASE=1} /^x-next-cursor:/{print $2; exit}' "${hdr}" | tr -d '\r')"
python3 - "${body}" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
assert isinstance(data, list), "format=min must return JSON array"
if data:
    x = data[0]
    for k in ["token_id", "chain_id", "token_address", "goplus_status", "checks_state", "safety_score", "is_surging"]:
        assert k in x, f"missing key: {k}"
    assert "risk_factors" in x and isinstance(x["risk_factors"], list), "risk_factors must be array"
    for k in ["dex_chart_url", "official_website_url", "twitter_url", "telegram_url"]:
        assert k in x, f"missing key: {k}"
    # Numeric fields must be numbers (or null)
    for k in ["price_usd", "liquidity_usd", "volume_24h", "fdv", "price_change_5m", "price_change_1h"]:
        v = x.get(k, None)
        assert (v is None) or isinstance(v, (int, float)), f"{k} must be number/null (got {type(v)})"
    # Txns activity metric must exist (int/null)
    assert "txns_24h" in x, "missing key: txns_24h"
    v = x.get("txns_24h", None)
    assert (v is None) or isinstance(v, int), f"txns_24h must be int/null (got {type(v)})"
    # Unknown state must never be 100 (critical regression check)
    if x.get("goplus_status") in ("pending", "unsupported"):
        assert x.get("safety_score") != 100, "unknown GoPlus state must not return 100"
print("  ok: get-feed(min) schema + numeric types")
PY
rm -rf "${tmpdir}"
echo

echo "6b) Smoke: repeat exposure toggle (allow_repeat)"
# First, consume up to one full page (<=20) so those become "seen"
seen_count="$(curl -sS -H "x-client-id: verify-repeat" "${SUPABASE_URL}/functions/v1/get-feed?limit=20&chains=solana&format=min" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d))')"
# Second call without allow_repeat should return 0 if token pool <= 20
after_count="$(curl -sS -H "x-client-id: verify-repeat" "${SUPABASE_URL}/functions/v1/get-feed?limit=20&chains=solana&format=min" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d))')"
# Third call with allow_repeat should return >0 when we already saw some
repeat_count="$(curl -sS -H "x-client-id: verify-repeat" "${SUPABASE_URL}/functions/v1/get-feed?limit=20&chains=solana&format=min&allow_repeat=true" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d))')"
if [[ "${seen_count}" -gt 0 && "${after_count}" -eq 0 && "${repeat_count}" -gt 0 ]]; then
  echo "  ok: allow_repeat re-enables seen tokens"
else
  echo "  warn: allow_repeat toggle check may be inconclusive (seen=${seen_count} after=${after_count} repeat=${repeat_count})"
fi
echo

echo "7) Smoke: wishlist capture + ROI (get-wishlist)"
cid="verify-wishlist"
tok="solana:So11111111111111111111111111111111111111112"
curl -sS -X POST -H "x-client-id: ${cid}" -H "Content-Type: application/json" \
  -d "{\"token_id\":\"${tok}\"}" \
  "${SUPABASE_URL}/functions/v1/wishlist" | sed -n '1,2p' | sed 's/.*/  &/'
curl -sS -H "x-client-id: ${cid}" \
  "${SUPABASE_URL}/functions/v1/get-wishlist?limit=5" | sed -n '1,5p' | sed 's/.*/  &/'
curl -sS -X DELETE -H "x-client-id: ${cid}" \
  "${SUPABASE_URL}/functions/v1/wishlist?token_id=${tok}" | sed -n '1,2p' | sed 's/.*/  &/'
echo

echo "Done."

