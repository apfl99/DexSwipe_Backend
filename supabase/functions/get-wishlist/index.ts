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
      if (res.ok) return await res.json();
      lastText = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) continue;
      throw new Error(`GoPlus HTTP ${res.status}: ${lastText}`);
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
    const lower = tokenAddress.toLowerCase();
    const direct = result[lower] ?? result[tokenAddress] ?? result[tokenAddress.toLowerCase()];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  return obj;
}

function safetyScoreFromGoPlus(x: {
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

  // 3) Live-Sync: always refresh current price for all wishlist tokens.
  const staleTargets: Array<{ token_id: string; chain_id: string; token_address: string }> = parsedTargets;

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

  // 4) GoPlus realtime merge (cache-first, then live batch fetch)
  const mappingsRes = await supabase.from("chain_mappings").select("*");
  const mappings = new Map<string, { goplus_mode: string; goplus_chain_id: string | null }>();
  if (!mappingsRes.error) for (const r of mappingsRes.data ?? []) mappings.set((r as any).dexscreener_chain_id, r as any);

  const apiKey = Deno.env.get("GOPLUS_API_KEY") ?? null;
  const goByToken = new Map<string, any>();

  // Group wishlist targets by chain
  const byChainTargets = new Map<string, Array<{ token_id: string; token_address: string }>>();
  for (const t of parsedTargets) {
    const arr = byChainTargets.get(t.chain_id) ?? [];
    arr.push({ token_id: t.token_id, token_address: t.token_address });
    byChainTargets.set(t.chain_id, arr);
  }

  await Promise.all(
    Array.from(byChainTargets.entries()).map(async ([chainId, arr]) => {
      const m = mappings.get(chainId);
      if (!m) {
        for (const x of arr) goByToken.set(`${chainId}:${x.token_address}`.toLowerCase(), { status: "unsupported" });
        return;
      }

      const addrs = arr.map((x) => x.token_address);
      const cached = await supabase
        .from("goplus_token_security_cache")
        .select("token_address,scanned_at,is_honeypot,cannot_sell,buy_tax,sell_tax,trust_list,is_blacklisted")
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

      const uniqNeed = Array.from(new Set(need.map((a) => a.toLowerCase())));
      if (uniqNeed.length === 0) return;

      const baseUrl =
        m.goplus_mode === "solana"
          ? "https://api.gopluslabs.io/api/v1/solana/token_security"
          : `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(m.goplus_chain_id ?? "")}`;

      for (let i = 0; i < uniqNeed.length; i += 20) {
        const chunk = uniqNeed.slice(i, i + 20);
        const url = `${baseUrl}?contract_addresses=${encodeURIComponent(chunk.join(","))}`;
        const payload = await fetchGoPlusJson(url, apiKey, 1200).catch(() => null);
        const nowIso = new Date().toISOString();
        const upRows: any[] = [];

        for (const a of chunk) {
          const resObj = payload ? extractGoPlusResult(payload, a) ?? {} : null;
          if (!resObj) {
            goByToken.set(`${chainId}:${a}`.toLowerCase(), { status: "scanning" });
            continue;
          }

          const cannot_sell = flag((resObj as any)["cannot_sell"] ?? (resObj as any)["cannotSell"]);
          const is_honeypot = flag((resObj as any)["is_honeypot"] ?? (resObj as any)["isHoneypot"]);
          const buy_tax = num((resObj as any)["buy_tax"] ?? (resObj as any)["buyTax"]);
          const sell_tax = num((resObj as any)["sell_tax"] ?? (resObj as any)["sellTax"]);
          const trust_list = flag(
            (resObj as any)["trust_list"] ??
              (resObj as any)["trustList"] ??
              (resObj as any)["is_in_trust_list"] ??
              (resObj as any)["isInTrustList"],
          );
          const is_blacklisted = flag(
            (resObj as any)["is_blacklisted"] ?? (resObj as any)["isBlacklisted"] ?? (resObj as any)["blacklisted"],
          );

          goByToken.set(`${chainId}:${a}`.toLowerCase(), {
            status: "live",
            scanned_at: nowIso,
            cannot_sell,
            is_honeypot,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
          });

          upRows.push({
            chain_id: chainId,
            token_address: a,
            raw: payload,
            scanned_at: nowIso,
            cannot_sell,
            is_honeypot,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
          });
        }

        if (upRows.length) await supabase.from("goplus_token_security_cache").upsert(upRows, { onConflict: "chain_id,token_address" });
      }
    }),
  );

  // Load latest token snapshots for response (after Dex refresh)
  const latestTokens = await supabase
    .from("tokens")
    .select("token_id,chain_id,token_address,symbol,logo_url,price_usd,price_change_5m,price_change_1h,updated_at")
    .in("token_id", tokenIds);
  if (latestTokens.error) return json({ error: latestTokens.error.message }, { status: 500 });
  const latestMap = new Map((latestTokens.data ?? []).map((r: any) => [r.token_id, r]));

  const out = items.map((w) => {
    const p = parseTokenId(w.token_id);
    const chainId = p?.chain_id ?? "";
    const tokenAddr = p?.token_address ?? "";
    const t = latestMap.get(w.token_id);
    const go = goByToken.get(`${chainId}:${tokenAddr}`.toLowerCase()) ?? { status: "scanning" };
    const status = go.status ?? "scanning";

    const currentPrice = t?.price_usd ?? null;
    return {
      token_id: w.token_id,
      chain_id: chainId || (t?.chain_id ?? null),
      token_address: tokenAddr || (t?.token_address ?? null),
      symbol: t?.symbol ?? null,
      logo_url: t?.logo_url ?? null,
      captured_price: w.captured_price,
      captured_at: w.captured_at,
      current_price: currentPrice,
      roi_since_captured: roiSinceCaptured(currentPrice, w.captured_price),
      price_change_5m: t?.price_change_5m ?? null,
      price_change_1h: t?.price_change_1h ?? null,
      is_surging: t?.price_change_5m !== null && t?.price_change_1h !== null ? t.price_change_5m > t.price_change_1h : false,
      goplus_status: status,
      goplus_is_honeypot: (go as any).is_honeypot ?? null,
      goplus_buy_tax: num((go as any).buy_tax),
      goplus_sell_tax: num((go as any).sell_tax),
      goplus_trust_list: (go as any).trust_list ?? null,
      goplus_is_blacklisted: (go as any).is_blacklisted ?? null,
      safety_score: safetyScoreFromGoPlus({
        is_honeypot: (go as any).is_honeypot ?? null,
        cannot_sell: (go as any).cannot_sell ?? null,
        is_blacklisted: (go as any).is_blacklisted ?? null,
        sell_tax: num((go as any).sell_tax),
      }),
      updated_at: t?.updated_at ?? new Date(0).toISOString(),
    };
  });

  return json({ items: out, limit, refreshed: { requested: staleTargets.length, updated: updatedCount } });
});

