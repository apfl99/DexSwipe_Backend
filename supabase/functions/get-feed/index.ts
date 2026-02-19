import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

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
  price_usd: number | string | null;
  liquidity_usd: number | string | null;
  volume_24h: number | string | null;
  fdv: number | string | null;
  market_cap: number | string | null;
  price_change_5m: number | string | null;
  price_change_15m: number | string | null;
  price_change_1h: number | string | null;
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
  const p5 = toNum(r.price_change_5m);
  const p1h = toNum(r.price_change_1h);
  // Some providers don't return `m15`; fallback to a linear estimate from 1h.
  const p15 = toNum(r.price_change_15m) ?? (p1h !== null ? p1h / 4 : null);
  if (p5 === null || p15 === null || p1h === null) return false;
  if (!Number.isFinite(p5) || !Number.isFinite(p15) || !Number.isFinite(p1h)) return false;

  // Require positive momentum and acceleration.
  // - p5 >= 0.6% AND p5 > p15/3 AND p15 > p1h/4
  return p5 >= 0.6 && p5 > p15 / 3 && p15 > p1h / 4;
}

type DexPair = Record<string, unknown> & {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  fdv?: number;
  marketCap?: number;
  priceChange?: Record<string, number>;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }>; socials?: Array<{ type?: string; url?: string }> };
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function flag(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
  }
  return null;
}

function volume24h(pair: DexPair): number | null {
  const v = pair.volume;
  if (!v || typeof v !== "object") return null;
  const n = (v as any).h24;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function webp(url: string | null): string | null {
  if (!url) return null;
  if (url.includes("format=auto")) return url.replace("format=auto", "format=webp");
  return url;
}

function websiteUrl(pair: DexPair): string | null {
  const w = pair.info?.websites;
  const u0 = Array.isArray(w) && w.length ? w[0]?.url : undefined;
  return typeof u0 === "string" && u0.trim() ? u0.trim() : null;
}

function dexChartUrl(pair: DexPair): string | null {
  const u = pair.url;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

function socialUrl(pair: DexPair, kind: "twitter" | "telegram"): string | null {
  const s = pair.info?.socials;
  if (!Array.isArray(s) || !s.length) return null;
  for (const it of s) {
    const t = typeof it?.type === "string" ? it.type.toLowerCase() : "";
    const u = typeof it?.url === "string" ? it.url.trim() : "";
    if (!u) continue;
    if (kind === "twitter" && (t === "twitter" || t === "x")) return u;
    if (kind === "telegram" && t === "telegram") return u;
  }
  return null;
}

function bestPairsByToken(pairs: DexPair[], chainId: string): Map<string, DexPair> {
  const out = new Map<string, { liq: number; p: DexPair }>();
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    if (p.chainId !== chainId) continue;
    const addr = p.baseToken?.address;
    if (typeof addr !== "string") continue;
    const liq = toNum((p.liquidity as any)?.usd) ?? 0;
    const k = addr.toLowerCase();
    const cur = out.get(k);
    if (!cur || liq > cur.liq) out.set(k, { liq, p });
  }
  return new Map(Array.from(out.entries()).map(([k, v]) => [k, v.p]));
}

async function fetchGoPlusJson(url: string, apiKey: string | null, timeoutMs: number): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const attempts: Array<Record<string, string>> = apiKey
      ? [
          { ...headers, Authorization: `Bearer ${apiKey}` },
          { ...headers, "X-API-KEY": apiKey },
          { ...headers, apikey: apiKey },
        ]
      : [headers];
    let lastText = "";
    for (const h of attempts) {
      const res = await fetch(url, { headers: h, signal: controller.signal });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        lastText = text;
        if (res.status === 401 || res.status === 403) continue;
        throw new Error(`GoPlus HTTP ${res.status}: ${lastText}`);
      }

      // GoPlus can return HTTP 200 even when auth fails (e.g., code=4012).
      // In that case, try the next header style.
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`GoPlus non-JSON 200: ${text}`);
      }
      const codeRaw = json?.code ?? json?.Code ?? null;
      const code = typeof codeRaw === "number" ? codeRaw : typeof codeRaw === "string" ? Number.parseInt(codeRaw, 10) : NaN;
      const msg = typeof json?.message === "string" ? json.message : "";
      if (code === 1) return json;
      lastText = text;
      if (code === 4012 || msg.toLowerCase().includes("signature verification failure")) continue;
      return json;
    }
    throw new Error(`GoPlus unauthorized: ${lastText}`);
  } finally {
    clearTimeout(t);
  }
}

function extractGoPlusResult(payload: unknown, tokenAddress: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as any;
  const result = obj.result;
  if (result && typeof result === "object") {
    // Solana addresses are case-sensitive. Try exact key first, then fall back.
    const direct = result[tokenAddress] ?? result[tokenAddress.toLowerCase()] ?? result[tokenAddress.toUpperCase()];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  return obj;
}

function safetyScoreFromHybrid(x: {
  is_honeypot: boolean | null;
  cannot_sell: boolean | null;
  is_blacklisted: boolean | null;
  sell_tax: number | null;
}): number {
  let score = 100;
  if (x.cannot_sell) score = 0;
  if (x.is_honeypot) score = 0;
  if (x.is_blacklisted) score = 0;
  if (typeof x.sell_tax === "number") {
    if (x.sell_tax >= 0.5) score -= 70;
    else if (x.sell_tax >= 0.2) score -= 35;
    else if (x.sell_tax >= 0.1) score -= 20;
  }
  return clampScore(score);
}

type GoPlusSignals = {
  // status
  status: "live" | "cached" | "stale" | "scanning" | "unsupported";
  provider_error?: string | null;
  // critical
  is_honeypot: boolean | null;
  is_blacklisted: boolean | null;
  cannot_sell_all: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  // high (-20)
  is_proxy: boolean | null;
  transfer_pausable: boolean | null;
  slippage_modifiable: boolean | null;
  external_call: boolean | null;
  // medium (-10)
  owner_change_balance: boolean | null;
  hidden_owner: boolean | null;
  cannot_buy: boolean | null;
  trading_cooldown: boolean | null;
  // low (-5)
  is_open_source: boolean | null;
  is_mintable: boolean | null;
  take_back_ownership: boolean | null;
};

type ChecksState = "pending" | "complete" | "limited" | "unsupported";

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function hasAnySignal(s: GoPlusSignals): boolean {
  const vals: Array<unknown> = [
    s.is_honeypot,
    s.is_blacklisted,
    s.cannot_sell_all,
    s.buy_tax,
    s.sell_tax,
    s.is_proxy,
    s.transfer_pausable,
    s.slippage_modifiable,
    s.external_call,
    s.owner_change_balance,
    s.hidden_owner,
    s.cannot_buy,
    s.trading_cooldown,
    s.is_open_source,
    s.is_mintable,
    s.take_back_ownership,
  ];
  return vals.some((v) => v !== null && v !== undefined);
}

function scoreDeductionModel(input: {
  // provider
  go: GoPlusSignals;
  // quality caches (from RPC)
  url_is_phishing: boolean | null;
  url_dapp_risk_level: string | null;
  rug_is_rugpull_risk: boolean | null;
  rug_risk_level: string | null;
  // queue-derived
  checks_state: ChecksState;
}): {
  safety_score: number | null;
  is_security_risk: boolean;
  risk_factors: string[];
} {
  const go = input.go;
  const factors: string[] = [];

  // Unsupported checks: explicit, not "unknown"
  if (input.checks_state === "unsupported" || go.status === "unsupported") {
    return { safety_score: null, is_security_risk: false, risk_factors: ["Checks Unsupported (chain)"] };
  }

  // Pending checks: explicit, not "unknown"
  if (input.checks_state === "pending") {
    // Still allow hard evidence from URL/rugpull caches (if any),
    // but keep safety_score null until token security checks are complete.
    if (input.url_is_phishing === true) return { safety_score: null, is_security_risk: true, risk_factors: ["Phishing Site"] };
    if (input.rug_is_rugpull_risk === true) {
      const lvl = (input.rug_risk_level ?? "").trim();
      return { safety_score: null, is_security_risk: true, risk_factors: [lvl ? `Rugpull Risk (${lvl})` : "Rugpull Risk"] };
    }
    // UI should render '-' when safety_score is null.
    return { safety_score: null, is_security_risk: false, risk_factors: ["Checks Pending"] };
  }

  // URL / rugpull signals (explicit, cross-chain where available)
  if (input.url_is_phishing === true) factors.push("Phishing Site");
  if (input.rug_is_rugpull_risk === true) {
    const lvl = (input.rug_risk_level ?? "").trim();
    factors.push(lvl ? `Rugpull Risk (${lvl})` : "Rugpull Risk");
  }

  // Limited checks: explicit reason
  if (input.checks_state === "limited") {
    if (typeof go.provider_error === "string" && go.provider_error.trim()) {
      return { safety_score: null, is_security_risk: false, risk_factors: [go.provider_error.trim()] };
    }
    if (factors.length) {
      // We have some hard signals; keep score conservative but not "unknown"
      return { safety_score: null, is_security_risk: true, risk_factors: factors };
    }
    return { safety_score: null, is_security_risk: false, risk_factors: ["Checks Limited (provider fields missing)"] };
  }

  // Complete: apply GoPlus deduction model (and keep URL/rug deductions)
  // If provider fields are unexpectedly empty, do NOT default to 100.
  if (!hasAnySignal(go) && factors.length === 0) {
    return { safety_score: null, is_security_risk: false, risk_factors: ["Checks Limited (provider fields missing)"] };
  }

  // Critical => 0
  if (go.is_honeypot === true) factors.push("Honeypot");
  if (go.is_blacklisted === true) factors.push("Blacklisted");
  if (go.cannot_sell_all === true) factors.push("Cannot Sell All");
  if (typeof go.sell_tax === "number" && go.sell_tax > 0.5) factors.push(`High Sell Tax (${pct(go.sell_tax)})`);
  if (typeof go.buy_tax === "number" && go.buy_tax > 0.5) factors.push(`High Buy Tax (${pct(go.buy_tax)})`);
  if (factors.some((f) => f === "Honeypot" || f === "Blacklisted" || f === "Cannot Sell All" || f.startsWith("High "))) {
    return { safety_score: 0, is_security_risk: true, risk_factors: factors };
  }

  let score = 100;

  // Penalize dApp risk level (from URL cache) if present.
  const d = (input.url_dapp_risk_level ?? "").toLowerCase();
  if (d === "high" || d === "danger") {
    score -= 40;
    factors.push("Dapp Risk High");
  } else if (d === "medium" || d === "warning") {
    score -= 20;
    factors.push("Dapp Risk Medium");
  } else if (d === "low") {
    score -= 5;
    factors.push("Dapp Risk Low");
  }

  // High risks (-20 each)
  if (go.is_proxy === true) {
    score -= 20;
    factors.push("Proxy Contract");
  }
  if (go.transfer_pausable === true) {
    score -= 20;
    factors.push("Transfer Pausable");
  }
  if (go.slippage_modifiable === true) {
    score -= 20;
    factors.push("Slippage Modifiable");
  }
  if (go.external_call === true) {
    score -= 20;
    factors.push("External Call");
  }

  // Medium risks (-10 each)
  if (go.owner_change_balance === true) {
    score -= 10;
    factors.push("Owner Can Change Balance");
  }
  if (go.hidden_owner === true) {
    score -= 10;
    factors.push("Hidden Owner");
  }
  if (go.cannot_buy === true) {
    score -= 10;
    factors.push("Cannot Buy");
  }
  if (go.trading_cooldown === true) {
    score -= 10;
    factors.push("Trading Cooldown");
  }

  // Low risks (-5 each)
  if (go.is_open_source === false) {
    score -= 5;
    factors.push("Not Open Source");
  }
  if (go.is_mintable === true) {
    score -= 5;
    factors.push("Mintable");
  }
  if (go.take_back_ownership === true) {
    score -= 5;
    factors.push("Take Back Ownership");
  }

  const finalScore = clampScore(score);
  const isRisk = finalScore < 60 || factors.includes("Phishing Site") || factors.some((f) => f.startsWith("Rugpull Risk"));
  return { safety_score: finalScore, is_security_risk: isRisk, risk_factors: factors };
}

function checksStateFromScoring(
  signals: GoPlusSignals,
  scored: { risk_factors: string[] },
  queueStatus: string | null,
): ChecksState {
  if (signals.status === "unsupported") return "unsupported";
  if (queueStatus === "pending" || queueStatus === "processing") return "pending";
  if (signals.status === "scanning") return "pending";
  if (typeof signals.provider_error === "string" && signals.provider_error.trim()) return "limited";
  if (!hasAnySignal(signals)) return "limited";
  return "complete";
}

function normalizeGoPlusStatus(
  raw: GoPlusSignals["status"],
  checksState: ChecksState,
): GoPlusSignals["status"] | "limited" | "pending" {
  // UI-facing status: if checks are limited, expose it explicitly.
  if (checksState === "pending") return "pending";
  if (checksState === "limited") return "limited";
  return raw;
}

Deno.serve(async (req) => {
  const clientId = req.headers.get("x-client-id")?.trim() ?? "";
  if (!clientId) {
    return json({ error: "missing required header: x-client-id" }, { status: 400 });
  }

  const u = new URL(req.url);
  const format = (u.searchParams.get("format") ?? "full").toLowerCase();
  // Hybrid realtime merge is expensive; cap hard to keep p95 under ~1.5s.
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "20", 10) || 20, 1), 20);
  const cursor = parseCursor(u.searchParams.get("cursor"));
  const chains = parseChains(u.searchParams.get("chains"));
  const minLiquidityUsd = parseNum(u.searchParams.get("min_liquidity_usd"));
  const minVolume24h = parseNum(u.searchParams.get("min_volume_24h"));
  const minFdv = parseNum(u.searchParams.get("min_fdv"));
  const includeRisky = (u.searchParams.get("include_risky") ?? "").toLowerCase() === "true";
  const allowRepeat = (u.searchParams.get("allow_repeat") ?? "").toLowerCase() === "true";
  const includeScanningParam = (u.searchParams.get("include_scanning") ?? "").trim();
  const includeScanning = includeScanningParam ? includeScanningParam.toLowerCase() === "true" : true;

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
    p_allow_repeat: allowRepeat,
  });
  if (res.error) return json({ error: res.error.message }, { status: 500 });
  const rows = (res.data ?? []) as FeedRow[];

  if (rows.length === 0) {
    return format === "min"
      ? jsonWithHeaders([], { "x-next-cursor": "" })
      : json({ tokens: [], limit, cursor, next_cursor: null, notes: { empty: true } });
  }

  const nextCursor = rows.length ? rows[rows.length - 1].updated_at : null;

  // --- Hybrid aggregation (DexScreener + GoPlus) ---
  const byChain = new Map<string, FeedRow[]>();
  for (const r of rows) {
    const arr = byChain.get(r.chain_id) ?? [];
    arr.push(r);
    byChain.set(r.chain_id, arr);
  }

  // 1) DexScreener: refresh and merge
  const dexByToken = new Map<string, any>();
  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, items]) => {
      const addrs = items.map((x) => x.token_address);
      for (let i = 0; i < addrs.length; i += 30) {
        const chunk = addrs.slice(i, i + 30);
        const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(
          chunk.join(","),
        )}`;
        const payload = await fetchJsonWithRetry(url, { maxAttempts: 2, timeoutMs: 1200 }).catch(() => []);
        const pairs = (Array.isArray(payload) ? payload : []) as DexPair[];
        const bestMap = bestPairsByToken(pairs, chainId);
        for (const addr of chunk) {
          const best = bestMap.get(addr.toLowerCase());
          if (!best) continue;
          dexByToken.set(`${chainId}:${addr}`.toLowerCase(), {
            price_usd: toNum(best.priceUsd),
            liquidity_usd: toNum((best.liquidity as any)?.usd),
            volume_24h: volume24h(best),
            fdv: toNum(best.fdv),
            market_cap: toNum(best.marketCap),
            price_change_5m: toNum((best.priceChange as any)?.m5 ?? (best.priceChange as any)?.["5m"]),
            price_change_15m: toNum((best.priceChange as any)?.m15 ?? (best.priceChange as any)?.["15m"]),
            price_change_1h: toNum((best.priceChange as any)?.h1),
            symbol: (best.baseToken as any)?.symbol ?? null,
            name: (best.baseToken as any)?.name ?? null,
            logo_url: webp((best.info as any)?.imageUrl ?? null),
            official_website_url: websiteUrl(best),
            dex_chart_url: dexChartUrl(best),
            twitter_url: socialUrl(best, "twitter"),
            telegram_url: socialUrl(best, "telegram"),
          });
        }

        // Persist refreshed snapshot (best-effort).
        const nowIso = new Date().toISOString();
        const upRows = chunk
          .map((addr) => {
            const d = dexByToken.get(`${chainId}:${addr}`.toLowerCase());
            if (!d) return null;
            return {
              token_id: `${chainId}:${addr}`,
              chain_id: chainId,
              token_address: addr,
              name: d.name,
              symbol: d.symbol,
              logo_url: d.logo_url,
              // Backward compatibility: website_url == official website
              website_url: d.official_website_url,
              official_website_url: d.official_website_url,
              dex_chart_url: d.dex_chart_url,
              twitter_url: d.twitter_url,
              telegram_url: d.telegram_url,
              price_usd: d.price_usd,
              liquidity_usd: d.liquidity_usd,
              volume_24h: d.volume_24h,
              fdv: d.fdv,
              market_cap: d.market_cap,
              price_change_5m: d.price_change_5m,
              price_change_15m: d.price_change_15m,
              price_change_1h: d.price_change_1h,
              last_fetched_at: nowIso,
              updated_at: nowIso,
            };
          })
          .filter(Boolean) as any[];
        if (upRows.length) await supabase.from("tokens").upsert(upRows, { onConflict: "chain_id,token_address" });
      }
    }),
  );

  // 2) GoPlus: cache-first then live batch fetch
  const mappingsRes = await supabase.from("chain_mappings").select("*");
  const mappings = new Map<string, { goplus_mode: string; goplus_chain_id: string | null }>();
  if (!mappingsRes.error) for (const r of mappingsRes.data ?? []) mappings.set((r as any).dexscreener_chain_id, r as any);

  const apiKey = Deno.env.get("GOPLUS_API_KEY") ?? null;
  const goByToken = new Map<string, any>();

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, items]) => {
      const m = mappings.get(chainId);
      if (!m) {
        for (const it of items) goByToken.set(`${chainId}:${it.token_address}`.toLowerCase(), { status: "unsupported" });
        return;
      }

      const addrs = items.map((x) => x.token_address);
      const cached = await supabase
        .from("goplus_token_security_cache")
        .select(
          "token_address,scanned_at,is_honeypot,is_blacklisted,cannot_sell,cannot_sell_all,buy_tax,sell_tax,trust_list,is_proxy,transfer_pausable,slippage_modifiable,external_call,owner_change_balance,hidden_owner,cannot_buy,trading_cooldown,is_open_source,is_mintable,take_back_ownership",
        )
        .eq("chain_id", chainId)
        .in("token_address", addrs);

      const freshMs = 6 * 60 * 60 * 1000;
      const need: string[] = [];
      if (!cached.error) {
        for (const row of cached.data ?? []) {
          const addr = String((row as any).token_address);
          const scannedAt = (row as any).scanned_at ? new Date((row as any).scanned_at).getTime() : 0;
          const fresh = scannedAt && Date.now() - scannedAt < freshMs;
          goByToken.set(`${chainId}:${addr}`.toLowerCase(), { status: fresh ? "cached" : "stale", ...row });
          if (!fresh) need.push(addr);
        }
      } else {
        need.push(...addrs);
      }

      for (const addr of addrs) {
        const k = `${chainId}:${addr}`.toLowerCase();
        if (!goByToken.has(k)) need.push(addr);
      }

      // IMPORTANT: Do not lowercase Solana addresses (case-sensitive).
      const uniqNeed = Array.from(new Set(need));
      if (uniqNeed.length === 0) return;

      const baseUrl =
        m.goplus_mode === "solana"
          ? "https://api.gopluslabs.io/api/v1/solana/token_security"
          : `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(m.goplus_chain_id ?? "")}`;

      for (let i = 0; i < uniqNeed.length; i += 20) {
        const chunk = uniqNeed.slice(i, i + 20);
        const url = `${baseUrl}?contract_addresses=${encodeURIComponent(chunk.join(","))}`;
        const payload = await fetchGoPlusJson(url, apiKey, 1200).catch(() => null);
        const envelope: any = payload && typeof payload === "object" ? payload : null;
        const codeRaw = envelope?.code ?? envelope?.Code ?? null;
        const code = typeof codeRaw === "number" ? codeRaw : typeof codeRaw === "string" ? Number.parseInt(codeRaw, 10) : NaN;
        const message = typeof envelope?.message === "string" ? envelope.message : null;
        const ok = code === 1;
        const nowIso = new Date().toISOString();
        const upRows: any[] = [];

        for (const a of chunk) {
          if (!payload) {
            goByToken.set(`${chainId}:${a}`.toLowerCase(), { status: "scanning", provider_error: "Checks Pending" });
            continue;
          }
          if (!ok) {
            const err = `Checks Limited (GoPlus code ${Number.isFinite(code) ? code : "unknown"}${message ? `: ${message}` : ""})`;
            goByToken.set(`${chainId}:${a}`.toLowerCase(), { status: "stale", provider_error: err });
            continue;
          }

          const resObj = extractGoPlusResult(payload, a) ?? {};
          const cannot_sell = flag((resObj as any)["cannot_sell"] ?? (resObj as any)["cannotSell"]);
          const cannot_sell_all = flag(
            (resObj as any)["cannot_sell_all"] ??
              (resObj as any)["cannotSellAll"] ??
              (resObj as any)["cannot_sell"] ??
              (resObj as any)["cannotSell"],
          );
          const is_honeypot = flag((resObj as any)["is_honeypot"] ?? (resObj as any)["isHoneypot"]);
          const is_proxy = flag((resObj as any)["is_proxy"] ?? (resObj as any)["isProxy"]);
          const buy_tax = toNum((resObj as any)["buy_tax"] ?? (resObj as any)["buyTax"]);
          const sell_tax = toNum((resObj as any)["sell_tax"] ?? (resObj as any)["sellTax"]);
          const trust_list = flag(
            (resObj as any)["trust_list"] ??
              (resObj as any)["trustList"] ??
              (resObj as any)["is_in_trust_list"] ??
              (resObj as any)["isInTrustList"],
          );
          const is_blacklisted = flag(
            (resObj as any)["is_blacklisted"] ?? (resObj as any)["isBlacklisted"] ?? (resObj as any)["blacklisted"],
          );
          const transfer_pausable = flag(
            (resObj as any)["transfer_pausable"] ??
              (resObj as any)["transferPausable"] ??
              (resObj as any)["can_pause_transfer"] ??
              (resObj as any)["canPauseTransfer"],
          );
          const slippage_modifiable = flag(
            (resObj as any)["slippage_modifiable"] ?? (resObj as any)["slippageModifiable"] ?? (resObj as any)["is_slippage_modifiable"],
          );
          const external_call = flag((resObj as any)["external_call"] ?? (resObj as any)["externalCall"]);
          const owner_change_balance = flag(
            (resObj as any)["owner_change_balance"] ??
              (resObj as any)["ownerChangeBalance"] ??
              (resObj as any)["owner_change_balance_ability"],
          );
          const hidden_owner = flag((resObj as any)["hidden_owner"] ?? (resObj as any)["hiddenOwner"]);
          const cannot_buy = flag((resObj as any)["cannot_buy"] ?? (resObj as any)["cannotBuy"]);
          const trading_cooldown = flag((resObj as any)["trading_cooldown"] ?? (resObj as any)["tradingCooldown"]);
          const is_open_source = flag((resObj as any)["is_open_source"] ?? (resObj as any)["isOpenSource"]);
          const is_mintable = flag((resObj as any)["is_mintable"] ?? (resObj as any)["isMintable"] ?? (resObj as any)["mintable"]);
          const take_back_ownership = flag(
            (resObj as any)["take_back_ownership"] ??
              (resObj as any)["takeBackOwnership"] ??
              (resObj as any)["can_take_back_ownership"],
          );

          // Solana token_security fields are objects with {status:"0"|"1"}.
          const solStatus = (k: string) => flag((resObj as any)?.[k]?.status);
          const solMintable = solStatus("mintable");
          const solFreezable = solStatus("freezable");
          const solMetadataMutable = solStatus("metadata_mutable");
          const solNonTransferable = solStatus("non_transferable");

          goByToken.set(`${chainId}:${a}`.toLowerCase(), {
            status: "live",
            scanned_at: nowIso,
            cannot_sell,
            cannot_sell_all: cannot_sell_all ?? solNonTransferable,
            is_honeypot,
            is_proxy,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
            transfer_pausable: transfer_pausable ?? solFreezable,
            slippage_modifiable,
            external_call,
            owner_change_balance,
            hidden_owner,
            cannot_buy,
            trading_cooldown,
            is_open_source,
            is_mintable: is_mintable ?? solMintable,
            take_back_ownership: take_back_ownership ?? solMetadataMutable,
          });

          upRows.push({
            chain_id: chainId,
            token_address: a,
            raw: payload,
            scanned_at: nowIso,
            cannot_sell,
            cannot_sell_all: cannot_sell_all ?? solNonTransferable,
            is_honeypot,
            is_proxy,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
            transfer_pausable: transfer_pausable ?? solFreezable,
            slippage_modifiable,
            external_call,
            owner_change_balance,
            hidden_owner,
            cannot_buy,
            trading_cooldown,
            is_open_source,
            is_mintable: is_mintable ?? solMintable,
            take_back_ownership: take_back_ownership ?? solMetadataMutable,
          });
        }

        if (upRows.length) await supabase.from("goplus_token_security_cache").upsert(upRows, { onConflict: "chain_id,token_address" });
      }
    }),
  );

  // 2.5) Check queue status to distinguish pending vs limited
  const queueStatusByToken = new Map<string, string>();
  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, items]) => {
      const addrs = items.map((x) => x.token_address);
      const qr = await supabase
        .from("token_security_scan_queue")
        .select("token_address,status")
        .eq("chain_id", chainId)
        .in("token_address", addrs);
      if (!qr.error) {
        for (const row of qr.data ?? []) {
          queueStatusByToken.set(`${chainId}:${(row as any).token_address}`.toLowerCase(), String((row as any).status ?? ""));
        }
      }
    }),
  );

  // Mark returned tokens as seen (so next request excludes them).
  const seenNow = new Date().toISOString();
  await supabase
    .from("seen_tokens")
    .upsert(rows.map((r) => ({ user_device_id: clientId, token_id: r.token_id, created_at: seenNow })), {
      onConflict: "user_device_id,token_id",
      ignoreDuplicates: true,
    });

  // Minimal mode: flat array only, with x-next-cursor header.
  if (format === "min") {
    const out = rows
      .map((r) => {
        const dex = dexByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? {};
        const go = goByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? { status: "scanning" };
        const status = go.status ?? "scanning";
        const hasSecurity = status === "cached" || status === "live";
        if (!includeScanning && !hasSecurity) return null;

        const price_change_5m = toNum(dex.price_change_5m) ?? toNum(r.price_change_5m);
        const price_change_1h = toNum(dex.price_change_1h) ?? toNum(r.price_change_1h);

        const signals: GoPlusSignals = {
          status,
          is_honeypot: go.is_honeypot ?? null,
          is_blacklisted: go.is_blacklisted ?? null,
          cannot_sell_all: go.cannot_sell_all ?? null,
          buy_tax: toNum(go.buy_tax),
          sell_tax: toNum(go.sell_tax),
          is_proxy: go.is_proxy ?? null,
          transfer_pausable: go.transfer_pausable ?? null,
          slippage_modifiable: go.slippage_modifiable ?? null,
          external_call: go.external_call ?? null,
          owner_change_balance: go.owner_change_balance ?? null,
          hidden_owner: go.hidden_owner ?? null,
          cannot_buy: go.cannot_buy ?? null,
          trading_cooldown: go.trading_cooldown ?? null,
          is_open_source: go.is_open_source ?? null,
          is_mintable: go.is_mintable ?? null,
          take_back_ownership: go.take_back_ownership ?? null,
        };
        const queueStatus = queueStatusByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? null;
        const checks_state = checksStateFromScoring(signals, { risk_factors: [] }, queueStatus);
        const scored = scoreDeductionModel({
          go: signals,
          url_is_phishing: r.url_is_phishing ?? null,
          url_dapp_risk_level: r.url_dapp_risk_level ?? null,
          rug_is_rugpull_risk: r.rug_is_rugpull_risk ?? null,
          rug_risk_level: r.rug_risk_level ?? null,
          checks_state,
        });
        const goplus_status = normalizeGoPlusStatus(status, checks_state);
        const goplus_verified = checks_state === "complete";
        const buys_24h = typeof r.buys_24h === "number" ? r.buys_24h : null;
        const sells_24h = typeof r.sells_24h === "number" ? r.sells_24h : null;
        const txns_24h =
          buys_24h !== null && sells_24h !== null ? buys_24h + sells_24h : buys_24h !== null ? buys_24h : sells_24h;

        return {
          token_id: r.token_id,
          chain_id: r.chain_id,
          token_address: r.token_address,
          symbol: dex.symbol ?? r.symbol,
          logo_url: dex.logo_url ?? r.logo_url,
          official_website_url: dex.official_website_url ?? null,
          dex_chart_url: dex.dex_chart_url ?? null,
          twitter_url: dex.twitter_url ?? null,
          telegram_url: dex.telegram_url ?? null,
          price_usd: toNum(dex.price_usd) ?? toNum(r.price_usd),
          liquidity_usd: toNum(dex.liquidity_usd) ?? toNum(r.liquidity_usd),
          volume_24h: toNum(dex.volume_24h) ?? toNum(r.volume_24h),
          fdv: toNum(dex.fdv) ?? toNum(r.fdv),
          txns_24h,
          price_change_5m,
          price_change_1h,
          is_surging: price_change_5m !== null && price_change_1h !== null ? price_change_5m > price_change_1h : false,
          safety_score: scored.safety_score,
          is_security_risk: scored.is_security_risk,
          risk_factors: scored.risk_factors,
          goplus_status,
          checks_state,
          goplus_is_honeypot: goplus_verified ? signals.is_honeypot : null,
          goplus_cannot_sell_all: goplus_verified ? signals.cannot_sell_all : null,
          goplus_buy_tax: goplus_verified ? signals.buy_tax : null,
          goplus_sell_tax: goplus_verified ? signals.sell_tax : null,
          goplus_trust_list: goplus_verified ? (go.trust_list ?? null) : null,
          goplus_is_blacklisted: goplus_verified ? signals.is_blacklisted : null,
        };
      })
      .filter(Boolean);
    return jsonWithHeaders(out, {
      "x-next-cursor": nextCursor ?? "",
    });
  }

  const out = rows
    .map((r) => {
      const dex = dexByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? {};
      const go = goByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? { status: "scanning" };
      const status = go.status ?? "scanning";
      const hasSecurity = status === "cached" || status === "live";
      if (!includeScanning && !hasSecurity) return null;

      const price_change_5m = toNum(dex.price_change_5m) ?? toNum(r.price_change_5m);
      const price_change_15m = toNum(dex.price_change_15m) ?? toNum(r.price_change_15m);
      const price_change_1h = toNum(dex.price_change_1h) ?? toNum(r.price_change_1h);

      const signals: GoPlusSignals = {
        status,
        is_honeypot: (go as any).is_honeypot ?? null,
        is_blacklisted: (go as any).is_blacklisted ?? null,
        cannot_sell_all: (go as any).cannot_sell_all ?? null,
        buy_tax: toNum((go as any).buy_tax),
        sell_tax: toNum((go as any).sell_tax),
        is_proxy: (go as any).is_proxy ?? null,
        transfer_pausable: (go as any).transfer_pausable ?? null,
        slippage_modifiable: (go as any).slippage_modifiable ?? null,
        external_call: (go as any).external_call ?? null,
        owner_change_balance: (go as any).owner_change_balance ?? null,
        hidden_owner: (go as any).hidden_owner ?? null,
        cannot_buy: (go as any).cannot_buy ?? null,
        trading_cooldown: (go as any).trading_cooldown ?? null,
        is_open_source: (go as any).is_open_source ?? null,
        is_mintable: (go as any).is_mintable ?? null,
        take_back_ownership: (go as any).take_back_ownership ?? null,
      };
      const queueStatus = queueStatusByToken.get(`${r.chain_id}:${r.token_address}`.toLowerCase()) ?? null;
      const checks_state = checksStateFromScoring(signals, { risk_factors: [] }, queueStatus);
      const scored = scoreDeductionModel({
        go: signals,
        url_is_phishing: r.url_is_phishing ?? null,
        url_dapp_risk_level: r.url_dapp_risk_level ?? null,
        rug_is_rugpull_risk: r.rug_is_rugpull_risk ?? null,
        rug_risk_level: r.rug_risk_level ?? null,
        checks_state,
      });
      const goplus_status = normalizeGoPlusStatus(status, checks_state);
      const goplus_verified = checks_state === "complete";
      const buys_24h = typeof r.buys_24h === "number" ? r.buys_24h : null;
      const sells_24h = typeof r.sells_24h === "number" ? r.sells_24h : null;
      const txns_24h =
        buys_24h !== null && sells_24h !== null ? buys_24h + sells_24h : buys_24h !== null ? buys_24h : sells_24h;

      return {
        token_id: r.token_id,
        chain_id: r.chain_id,
        token_address: r.token_address,
        name: dex.name ?? r.name,
        symbol: dex.symbol ?? r.symbol,
        logo_url: dex.logo_url ?? r.logo_url,
        website_url: dex.official_website_url ?? r.website_url,
        official_website_url: dex.official_website_url ?? null,
        dex_chart_url: dex.dex_chart_url ?? null,
        twitter_url: dex.twitter_url ?? null,
        telegram_url: dex.telegram_url ?? null,
        price_usd: toNum(dex.price_usd) ?? toNum(r.price_usd),
        liquidity_usd: toNum(dex.liquidity_usd) ?? toNum(r.liquidity_usd),
        volume_24h: toNum(dex.volume_24h) ?? toNum(r.volume_24h),
        fdv: toNum(dex.fdv) ?? toNum(r.fdv),
        market_cap: toNum(dex.market_cap) ?? toNum(r.market_cap),
        buys_24h,
        sells_24h,
        txns_24h,
        price_change_5m,
        price_change_15m,
        price_change_1h,
        is_surging: price_change_5m !== null && price_change_1h !== null ? price_change_5m > price_change_1h : false,
        safety_score: scored.safety_score,
        is_security_risk: scored.is_security_risk,
        risk_factors: scored.risk_factors,
        goplus_status,
        checks_state,
        goplus_scanned_at: goplus_verified ? ((go as any).scanned_at ?? null) : null,
        goplus_is_honeypot: goplus_verified ? signals.is_honeypot : null,
        goplus_is_blacklisted: goplus_verified ? signals.is_blacklisted : null,
        goplus_cannot_sell_all: goplus_verified ? signals.cannot_sell_all : null,
        goplus_buy_tax: goplus_verified ? signals.buy_tax : null,
        goplus_sell_tax: goplus_verified ? signals.sell_tax : null,
        goplus_is_proxy: goplus_verified ? signals.is_proxy : null,
        goplus_transfer_pausable: goplus_verified ? signals.transfer_pausable : null,
        goplus_slippage_modifiable: goplus_verified ? signals.slippage_modifiable : null,
        goplus_external_call: goplus_verified ? signals.external_call : null,
        goplus_owner_change_balance: goplus_verified ? signals.owner_change_balance : null,
        goplus_hidden_owner: goplus_verified ? signals.hidden_owner : null,
        goplus_cannot_buy: goplus_verified ? signals.cannot_buy : null,
        goplus_trading_cooldown: goplus_verified ? signals.trading_cooldown : null,
        goplus_is_open_source: goplus_verified ? signals.is_open_source : null,
        goplus_is_mintable: goplus_verified ? signals.is_mintable : null,
        goplus_take_back_ownership: goplus_verified ? signals.take_back_ownership : null,
        goplus_trust_list: goplus_verified ? ((go as any).trust_list ?? null) : null,
        updated_at: r.updated_at,
        urls: {
          official_website: dex.official_website_url ?? null,
          dex_chart: dex.dex_chart_url ?? null,
          twitter: dex.twitter_url ?? null,
          telegram: dex.telegram_url ?? null,
        },
      };
    })
    .filter(Boolean);

  return json({
    tokens: out,
    limit,
    cursor,
    next_cursor: nextCursor,
    notes: {
      pagination: "cursor (keyset) using tokens.updated_at",
      anti_join: "LEFT JOIN seen_tokens + wishlist where null",
      hybrid: "DexScreener tokens/v1 + GoPlus token_security (parallel, cached)",
      include_scanning_default: true,
    },
  });
});

