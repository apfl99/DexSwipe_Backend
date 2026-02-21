/// <reference path="./tsserver_shims.d.ts" />

export type GoPlusPlanTier = "FREE" | "PRO";

export type DexSwipePlanConfig = {
  tier: GoPlusPlanTier;

  // GoPlus Token Security worker
  goplus_cu_budget_per_run: number;
  goplus_cache_ttl_hours: number;
  goplus_daily_max_scans: number | null; // null = unlimited

  // HTTP APIs (get-feed/get-wishlist) GoPlus usage policy
  goplus_allow_live_fetch_in_http_apis: boolean;

  // DexScreener ingestion pre-filter
  dexscreener_min_liquidity_usd: number;
  dexscreener_min_volume_24h_usd: number;
};

function parseTier(raw: string | null | undefined): GoPlusPlanTier {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "PRO") return "PRO";
  return "FREE";
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function getPlanConfig(): DexSwipePlanConfig {
  const tier = parseTier(Deno.env.get("GOPLUS_PLAN_TIER"));

  if (tier === "PRO") {
    return {
      tier,
      // 요구사항: 3,000 ~ 4,000 CU/Run
      goplus_cu_budget_per_run: clampInt(Number.parseInt(Deno.env.get("GOPLUS_CU_BUDGET_PER_RUN") ?? "3500", 10), 3000, 4000),
      goplus_cache_ttl_hours: clampInt(Number.parseInt(Deno.env.get("GOPLUS_CACHE_TTL_HOURS") ?? "6", 10), 1, 168),
      goplus_daily_max_scans: null,
      goplus_allow_live_fetch_in_http_apis: true,
      // 요구사항: liquidity > 2,000 & volume_24h > 5,000
      dexscreener_min_liquidity_usd: clampNum(Number.parseFloat(Deno.env.get("DEXSCREENER_MIN_LIQUIDITY_USD") ?? "2000"), 0, 1e12),
      dexscreener_min_volume_24h_usd: clampNum(Number.parseFloat(Deno.env.get("DEXSCREENER_MIN_VOLUME_24H_USD") ?? "5000"), 0, 1e12),
    };
  }

  // FREE (월 150k CU 방어)
  return {
    tier,
    // 요구사항: 100 CU/Run (하루 48회 => 4,800 CU/day 상한)
    goplus_cu_budget_per_run: clampInt(Number.parseInt(Deno.env.get("GOPLUS_CU_BUDGET_PER_RUN") ?? "100", 10), 1, 100),
    // FREE에서는 재스캔을 하루 1회 이하로 억제해, "일일 스캔 캡"이 의미 있게 동작하게 함
    goplus_cache_ttl_hours: clampInt(Number.parseInt(Deno.env.get("GOPLUS_CACHE_TTL_HOURS") ?? "24", 10), 1, 168),
    // 요구사항: 하루 최대 신규 스캔 150개
    goplus_daily_max_scans: clampInt(Number.parseInt(Deno.env.get("GOPLUS_DAILY_MAX_SCANS") ?? "150", 10), 0, 150),
    // FREE에서는 HTTP API에서 GoPlus 라이브 호출을 금지(캐시/큐 기반)
    goplus_allow_live_fetch_in_http_apis: false,
    // 요구사항: liquidity > 10,000 & volume_24h > 50,000
    dexscreener_min_liquidity_usd: clampNum(Number.parseFloat(Deno.env.get("DEXSCREENER_MIN_LIQUIDITY_USD") ?? "10000"), 0, 1e12),
    dexscreener_min_volume_24h_usd: clampNum(Number.parseFloat(Deno.env.get("DEXSCREENER_MIN_VOLUME_24H_USD") ?? "50000"), 0, 1e12),
  };
}

