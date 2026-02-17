import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

function getClientId(req: Request): string {
  return req.headers.get("x-client-id")?.trim() ?? "";
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

type WishlistRow = {
  token_id: string;
  created_at: string;
  captured_price: number | null;
  captured_at: string | null;
};

type TokenRow = {
  token_id: string;
  chain_id: string;
  token_address: string;
  symbol: string | null;
  logo_url: string | null;
  website_url?: string | null;
  price_usd: number | null;
  price_change_5m: number | null;
  price_change_1h: number | null;
  updated_at: string;
  security_always_deny: boolean | null;
  security_deny_reasons: string[] | null;
  url_is_phishing: boolean | null;
  url_dapp_risk_level: string | null;
  rug_is_rugpull_risk: boolean | null;
  rug_risk_level: string | null;
};

type Pair = Record<string, unknown> & {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }> };
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bestPairForToken(pairs: Pair[], chainId: string, tokenAddress: string): Pair | null {
  let best: { liq: number; p: Pair } | null = null;
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    if (p.chainId !== chainId) continue;
    const addr = p.baseToken?.address;
    if (typeof addr !== "string") continue;
    if (addr.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    const liq = num((p.liquidity as any)?.usd) ?? 0;
    if (!best || liq > best.liq) best = { liq, p };
  }
  return best ? best.p : null;
}

function safetyScore(r: TokenRow): number {
  if (r.security_always_deny) return 0;
  if (r.url_is_phishing) return 0;
  if (r.rug_is_rugpull_risk) return 0;

  let score = 100;
  const d = (r.url_dapp_risk_level ?? "").toLowerCase();
  if (d === "high" || d === "danger") score -= 40;
  else if (d === "medium" || d === "warning") score -= 20;
  else if (d === "low") score -= 5;

  const rr = (r.rug_risk_level ?? "").toLowerCase();
  if (rr === "high") score -= 40;
  else if (rr === "medium") score -= 20;
  else if (rr === "low") score -= 5;

  const reasons = r.security_deny_reasons ?? [];
  if (reasons.length >= 3) score -= 20;
  else if (reasons.length === 2) score -= 12;
  else if (reasons.length === 1) score -= 6;

  return clampScore(score);
}

function isSurging(r: TokenRow): boolean {
  const p5 = r.price_change_5m;
  const p1h = r.price_change_1h;
  if (p5 === null || p1h === null) return false;
  if (!Number.isFinite(p5) || !Number.isFinite(p1h)) return false;
  return p5 > p1h;
}

function roiSinceCaptured(current: number | null, captured: number | null): number | null {
  if (current === null || captured === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(captured) || captured <= 0) return null;
  return ((current - captured) / captured) * 100;
}

function parseTokenId(tokenId: string): { chain_id: string; token_address: string } | null {
  const i = tokenId.indexOf(":");
  if (i <= 0) return null;
  const chainId = tokenId.slice(0, i).trim();
  const tokenAddress = tokenId.slice(i + 1).trim();
  if (!chainId || !tokenAddress) return null;
  return { chain_id: chainId, token_address: tokenAddress };
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });

  const clientId = getClientId(req);
  if (!clientId) return json({ error: "missing required header: x-client-id" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "100", 10) || 100, 1), 200);

  // 1) Load wishlist inventory
  const wl = await supabase
    .from("wishlist")
    .select("token_id,created_at,captured_price,captured_at")
    .eq("user_device_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (wl.error) return json({ error: wl.error.message }, { status: 500 });
  const items = (wl.data ?? []) as WishlistRow[];
  if (items.length === 0) return json({ items: [], limit, refreshed: { requested: 0, updated: 0 } });

  const tokenIds = items.map((x) => x.token_id);
  const parsedTargets = items
    .map((w) => {
      const p = parseTokenId(w.token_id);
      return p ? { token_id: w.token_id, chain_id: p.chain_id, token_address: p.token_address } : null;
    })
    .filter(Boolean) as Array<{ token_id: string; chain_id: string; token_address: string }>;

  // 2) Load current token snapshots
  const tr = await supabase
    .from("tokens")
    .select("token_id,chain_id,token_address,symbol,logo_url,price_usd,price_change_5m,price_change_1h,updated_at")
    .in("token_id", tokenIds);
  if (tr.error) return json({ error: tr.error.message }, { status: 500 });
  const tokenRows = (tr.data ?? []) as Array<{
    token_id: string;
    chain_id: string;
    token_address: string;
    symbol: string | null;
    logo_url: string | null;
    price_usd: number | null;
    price_change_5m: number | null;
    price_change_1h: number | null;
    updated_at: string;
  }>;

  const tokenMap = new Map(tokenRows.map((r) => [r.token_id, r]));

  // 3) Lazy refresh: only stale (>=5m) or missing
  const staleMs = 5 * 60 * 1000;
  const nowMs = Date.now();
  const staleTargets: Array<{ token_id: string; chain_id: string; token_address: string }> = [];
  for (const w of parsedTargets) {
    const t = tokenMap.get(w.token_id);
    if (!t) {
      // Not in tokens snapshot yet -> fetch on-demand.
      staleTargets.push({ token_id: w.token_id, chain_id: w.chain_id, token_address: w.token_address });
      continue;
    }
    const ts = new Date(t.updated_at).getTime();
    const isStale = !Number.isFinite(ts) || nowMs - ts >= staleMs;
    const missing = t.price_usd === null;
    if (isStale || missing) staleTargets.push({ token_id: t.token_id, chain_id: t.chain_id, token_address: t.token_address });
  }

  let updatedCount = 0;

  // Group by chain and refresh via /tokens/v1/{chainId}/{tokenAddresses} (<=30 per request)
  const byChain = new Map<string, Array<{ token_id: string; token_address: string }>>();
  for (const t of staleTargets) {
    const arr = byChain.get(t.chain_id) ?? [];
    arr.push({ token_id: t.token_id, token_address: t.token_address });
    byChain.set(t.chain_id, arr);
  }

  for (const [chainId, arr] of byChain.entries()) {
    for (let i = 0; i < arr.length; i += 30) {
      const chunk = arr.slice(i, i + 30);
      const addresses = chunk.map((x) => x.token_address).join(",");
      const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(addresses)}`;
      const payload = await fetchJsonWithRetry(url, { maxAttempts: 3, timeoutMs: 15_000 });
      const pairs = (Array.isArray(payload) ? payload : []) as Pair[];

      // Build token update rows
      const upRows: any[] = [];
      for (const x of chunk) {
        const best = bestPairForToken(pairs, chainId, x.token_address);
        if (!best) continue;
        upRows.push({
          token_id: x.token_id,
          chain_id: chainId,
          token_address: x.token_address,
          symbol: best.baseToken?.symbol ?? null,
          logo_url: (best.info as any)?.imageUrl ?? null,
          price_usd: num(best.priceUsd),
          price_change_5m: num((best.priceChange as any)?.m5 ?? (best.priceChange as any)?.["5m"]),
          price_change_1h: num((best.priceChange as any)?.h1),
          last_fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      if (upRows.length) {
        const up = await supabase.from("tokens").upsert(upRows, { onConflict: "chain_id,token_address" });
        if (!up.error) updatedCount += upRows.length;
      }
    }
  }

  // 4) Re-load enriched rows (incl. GoPlus caches) for response
  // Join caches manually (cheap, exact match only).
  const secMap = new Map<string, { always_deny: boolean; deny_reasons: string[] }>();
  const urlMap = new Map<string, { is_phishing: boolean | null; dapp_risk_level: string | null }>();
  const rugMap = new Map<string, { is_rugpull_risk: boolean | null; risk_level: string | null }>();

  // Load latest token snapshots (need website_url for URL cache lookup).
  const latestTokens = await supabase
    .from("tokens")
    .select("token_id,chain_id,token_address,symbol,logo_url,website_url,price_usd,price_change_5m,price_change_1h,updated_at")
    .in("token_id", tokenIds);
  if (latestTokens.error) return json({ error: latestTokens.error.message }, { status: 500 });
  const latest = (latestTokens.data ?? []) as any[];
  const latestMap = new Map(latest.map((r) => [r.token_id, r]));

  // Exact-match cache fetch (per chain) to avoid huge scans.
  const chains = Array.from(new Set(latest.map((r) => r.chain_id).filter(Boolean)));
  for (const chainId of chains) {
    const addrs = latest
      .filter((r) => r.chain_id === chainId && typeof r.token_address === "string")
      .map((r) => r.token_address);
    const uniq = Array.from(new Set(addrs.map((s: string) => s.toLowerCase())));
    if (uniq.length === 0) continue;

    const sec = await supabase
      .from("goplus_token_security_cache")
      .select("chain_id,token_address,always_deny,deny_reasons")
      .eq("chain_id", chainId)
      .in("token_address", uniq);
    if (!sec.error) {
      for (const r of sec.data ?? []) {
        secMap.set(`${(r as any).chain_id}:${(r as any).token_address}`.toLowerCase(), {
          always_deny: (r as any).always_deny ?? false,
          deny_reasons: (r as any).deny_reasons ?? [],
        });
      }
    }

    const rug = await supabase
      .from("goplus_rugpull_cache")
      .select("chain_id,token_address,is_rugpull_risk,risk_level")
      .eq("chain_id", chainId)
      .in("token_address", uniq);
    if (!rug.error) {
      for (const r of rug.data ?? []) {
        rugMap.set(`${(r as any).chain_id}:${(r as any).token_address}`.toLowerCase(), {
          is_rugpull_risk: (r as any).is_rugpull_risk ?? null,
          risk_level: (r as any).risk_level ?? null,
        });
      }
    }
  }

  // URL cache: exact-match by url list
  const urls = Array.from(
    new Set(
      latest
        .map((r) => (typeof r.website_url === "string" ? r.website_url.trim() : ""))
        .filter((s) => s.length > 0),
    ),
  );
  if (urls.length) {
    for (let i = 0; i < urls.length; i += 100) {
      const chunk = urls.slice(i, i + 100);
      const ur = await supabase
        .from("goplus_url_risk_cache")
        .select("url,is_phishing,dapp_risk_level")
        .in("url", chunk);
      if (!ur.error) {
        for (const r of ur.data ?? []) {
          urlMap.set((r as any).url, {
            is_phishing: (r as any).is_phishing ?? null,
            dapp_risk_level: (r as any).dapp_risk_level ?? null,
          });
        }
      }
    }
  }

  const out = items.map((w) => {
    const t = latestMap.get(w.token_id);
    const chainId = t?.chain_id ?? (w.token_id.split(":")[0] ?? "");
    const tokenAddr = t?.token_address ?? (w.token_id.split(":")[1] ?? "");
    const sec = secMap.get(`${chainId}:${tokenAddr}`.toLowerCase());
    const rug = rugMap.get(`${chainId}:${tokenAddr}`.toLowerCase());
    const websiteUrl = typeof t?.website_url === "string" ? t.website_url : null;
    const urlRisk = websiteUrl ? urlMap.get(websiteUrl) : undefined;

    const merged: TokenRow = {
      token_id: w.token_id,
      chain_id: chainId,
      token_address: tokenAddr,
      symbol: t?.symbol ?? null,
      logo_url: t?.logo_url ?? null,
      website_url: websiteUrl,
      price_usd: t?.price_usd ?? null,
      price_change_5m: t?.price_change_5m ?? null,
      price_change_1h: t?.price_change_1h ?? null,
      updated_at: t?.updated_at ?? new Date(0).toISOString(),
      security_always_deny: sec?.always_deny ?? false,
      security_deny_reasons: sec?.deny_reasons ?? [],
      url_is_phishing: urlRisk?.is_phishing ?? null,
      url_dapp_risk_level: urlRisk?.dapp_risk_level ?? null,
      rug_is_rugpull_risk: rug?.is_rugpull_risk ?? null,
      rug_risk_level: rug?.risk_level ?? null,
    };

    const roi = roiSinceCaptured(merged.price_usd, w.captured_price);
    return {
      token_id: w.token_id,
      chain_id: merged.chain_id,
      token_address: merged.token_address,
      symbol: merged.symbol,
      logo_url: merged.logo_url,
      captured_price: w.captured_price,
      captured_at: w.captured_at,
      current_price: merged.price_usd,
      roi_since_captured: roi,
      price_change_5m: merged.price_change_5m,
      price_change_1h: merged.price_change_1h,
      is_surging: isSurging(merged),
      is_security_risk:
        (merged.security_always_deny ?? false) ||
        (merged.url_is_phishing ?? false) ||
        (merged.rug_is_rugpull_risk ?? false),
      safety_score: safetyScore(merged),
      updated_at: merged.updated_at,
    };
  });

  return json({
    items: out,
    limit,
    refreshed: { requested: staleTargets.length, updated: updatedCount },
  });
});

