import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

function jsonWithHeaders(body: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function parseChains(param: string | null): string[] | null {
  if (!param) return null;
  const parts = param.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function parseNum(param: string | null): number | null {
  if (!param) return null;
  const n = Number.parseFloat(param);
  return Number.isFinite(n) ? n : null;
}

function parseCursor(param: string | null): string | null {
  if (!param) return null;
  const d = new Date(param);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type FeedRow = {
  token_id: string;
  chain_id: string;
  token_address: string;
  name: string | null;
  symbol: string | null;
  logo_url: string | null;
  website_url: string | null;
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_24h: number | null;
  fdv: number | null;
  market_cap: number | null;
  price_change_5m: number | null;
  price_change_15m: number | null;
  price_change_1h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  pair_created_at: string | null;
  updated_at: string;
  security_always_deny: boolean | null;
  security_deny_reasons: string[] | null;
  security_scanned_at: string | null;
  url_is_phishing: boolean | null;
  url_dapp_risk_level: string | null;
  url_scanned_at: string | null;
  rug_is_rugpull_risk: boolean | null;
  rug_risk_level: string | null;
  rug_scanned_at: string | null;
};

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function safetyScore(r: FeedRow): number {
  // 0..100 (higher is safer). Deterministic and cheap.
  // - hard fail: always_deny / phishing / rugpull-risk => 0
  if (r.security_always_deny) return 0;
  if (r.url_is_phishing) return 0;
  if (r.rug_is_rugpull_risk) return 0;

  let score = 100;

  // Penalize dApp risk level if present.
  const d = (r.url_dapp_risk_level ?? "").toLowerCase();
  if (d === "high" || d === "danger") score -= 40;
  else if (d === "medium" || d === "warning") score -= 20;
  else if (d === "low") score -= 5;

  // Penalize rugpull risk level if present.
  const rr = (r.rug_risk_level ?? "").toLowerCase();
  if (rr === "high") score -= 40;
  else if (rr === "medium") score -= 20;
  else if (rr === "low") score -= 5;

  // Security deny reasons (soft penalty if present but not always_deny).
  const reasons = r.security_deny_reasons ?? [];
  if (reasons.length >= 3) score -= 20;
  else if (reasons.length === 2) score -= 12;
  else if (reasons.length === 1) score -= 6;

  return clampScore(score);
}

function isSurging(r: FeedRow): boolean {
  // Velocity/acceleration heuristic using 5m/15m/1h price change (best-effort).
  // Surging when short-term move outpaces longer windows consistently.
  const p5 = r.price_change_5m;
  const p1h = r.price_change_1h;
  // Some providers don't return `m15`; fallback to a linear estimate from 1h.
  const p15 = r.price_change_15m ?? (p1h !== null ? p1h / 4 : null);
  if (p5 === null || p15 === null || p1h === null) return false;
  if (!Number.isFinite(p5) || !Number.isFinite(p15) || !Number.isFinite(p1h)) return false;

  // Require positive momentum and acceleration.
  // - p5 >= 0.6% AND p5 > p15/3 AND p15 > p1h/4
  return p5 >= 0.6 && p5 > p15 / 3 && p15 > p1h / 4;
}

Deno.serve(async (req) => {
  const clientId = req.headers.get("x-client-id")?.trim() ?? "";
  if (!clientId) {
    return json({ error: "missing required header: x-client-id" }, { status: 400 });
  }

  const u = new URL(req.url);
  const format = (u.searchParams.get("format") ?? "full").toLowerCase();
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);
  const cursor = parseCursor(u.searchParams.get("cursor"));
  const chains = parseChains(u.searchParams.get("chains"));
  const minLiquidityUsd = parseNum(u.searchParams.get("min_liquidity_usd"));
  const minVolume24h = parseNum(u.searchParams.get("min_volume_24h"));
  const minFdv = parseNum(u.searchParams.get("min_fdv"));
  const includeRisky = (u.searchParams.get("include_risky") ?? "").toLowerCase() === "true";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const res = await supabase.rpc("dexswipe_get_feed", {
    p_client_id: clientId,
    p_limit: limit,
    p_cursor: cursor,
    p_chains: chains,
    p_min_liquidity_usd: minLiquidityUsd,
    p_min_volume_24h: minVolume24h,
    p_min_fdv: minFdv,
    p_include_risky: includeRisky,
  });
  if (res.error) return json({ error: res.error.message }, { status: 500 });
  const rows = (res.data ?? []) as FeedRow[];

  // Mark returned tokens as seen (so next request excludes them).
  if (rows.length) {
    const now = new Date().toISOString();
    const seen = rows.map((r) => ({ user_device_id: clientId, token_id: r.token_id, created_at: now }));
    await supabase.from("seen_tokens").upsert(seen, { onConflict: "user_device_id,token_id", ignoreDuplicates: true });
  }

  const nextCursor = rows.length ? rows[rows.length - 1].updated_at : null;

  // Minimal mode: flat array only, with x-next-cursor header.
  if (format === "min") {
    const out = rows.map((r) => {
      const isSecurityRisk =
        (r.security_always_deny ?? false) ||
        (r.url_is_phishing ?? false) ||
        (r.rug_is_rugpull_risk ?? false);
      return {
        id: r.token_id,
        chain_id: r.chain_id,
        logo_url: r.logo_url,
        symbol: r.symbol,
        price_change_5m: r.price_change_5m,
        price_change_15m: r.price_change_15m,
        price_change_1h: r.price_change_1h,
        is_security_risk: isSecurityRisk,
        safety_score: safetyScore(r),
        is_surging: isSurging(r),
      };
    });
    return jsonWithHeaders(out, {
      "x-next-cursor": nextCursor ?? "",
    });
  }

  return json({
    tokens: rows.map((r) => ({
      token_id: r.token_id,
      chain_id: r.chain_id,
      token_address: r.token_address,
      name: r.name,
      symbol: r.symbol,
      logo_url: r.logo_url,
      website_url: r.website_url,
      price_usd: r.price_usd,
      liquidity_usd: r.liquidity_usd,
      volume_24h: r.volume_24h,
      fdv: r.fdv,
      market_cap: r.market_cap,
      price_change_5m: r.price_change_5m,
      price_change_15m: r.price_change_15m,
      price_change_1h: r.price_change_1h,
      is_surging: isSurging(r),
      safety_score: safetyScore(r),
      buys_24h: r.buys_24h,
      sells_24h: r.sells_24h,
      pair_created_at: r.pair_created_at,
      updated_at: r.updated_at,
      security: {
        always_deny: r.security_always_deny ?? false,
        deny_reasons: r.security_deny_reasons ?? [],
        scanned_at: r.security_scanned_at ?? null,
      },
      quality: {
        url_risk: {
          is_phishing: r.url_is_phishing ?? null,
          dapp_risk_level: r.url_dapp_risk_level ?? null,
          scanned_at: r.url_scanned_at ?? null,
        },
        rugpull: {
          is_rugpull_risk: r.rug_is_rugpull_risk ?? null,
          risk_level: r.rug_risk_level ?? null,
          scanned_at: r.rug_scanned_at ?? null,
        },
      },
    })),
    limit,
    cursor,
    next_cursor: nextCursor,
    notes: {
      pagination: "cursor (keyset) using tokens.updated_at",
      anti_join: "LEFT JOIN seen_tokens(user_device_id, token_id) where seen is null",
    },
  });
});

