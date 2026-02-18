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
  url?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }>; socials?: Array<{ type?: string; url?: string }> };
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

type GoPlusSignals = {
  status: "live" | "cached" | "stale" | "scanning" | "unsupported";
  is_honeypot: boolean | null;
  is_blacklisted: boolean | null;
  cannot_sell_all: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  is_proxy: boolean | null;
  transfer_pausable: boolean | null;
  slippage_modifiable: boolean | null;
  external_call: boolean | null;
  owner_change_balance: boolean | null;
  hidden_owner: boolean | null;
  cannot_buy: boolean | null;
  trading_cooldown: boolean | null;
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

function scoreDeductionModel(s: GoPlusSignals): { safety_score: number | null; is_security_risk: boolean; risk_factors: string[] } {
  if (s.status !== "live" && s.status !== "cached" && s.status !== "stale") {
    return { safety_score: 50, is_security_risk: true, risk_factors: ["Unknown Risk (GoPlus unavailable)"] };
  }
  if (!hasAnySignal(s)) {
    return { safety_score: 50, is_security_risk: true, risk_factors: ["Unknown Risk (GoPlus missing fields)"] };
  }

  const factors: string[] = [];
  if (s.is_honeypot === true) factors.push("Honeypot");
  if (s.is_blacklisted === true) factors.push("Blacklisted");
  if (s.cannot_sell_all === true) factors.push("Cannot Sell All");
  if (typeof s.sell_tax === "number" && s.sell_tax > 0.5) factors.push(`High Sell Tax (${pct(s.sell_tax)})`);
  if (typeof s.buy_tax === "number" && s.buy_tax > 0.5) factors.push(`High Buy Tax (${pct(s.buy_tax)})`);
  if (factors.length) return { safety_score: 0, is_security_risk: true, risk_factors: factors };

  let score = 100;

  if (s.is_proxy === true) {
    score -= 20;
    factors.push("Proxy Contract");
  }
  if (s.transfer_pausable === true) {
    score -= 20;
    factors.push("Transfer Pausable");
  }
  if (s.slippage_modifiable === true) {
    score -= 20;
    factors.push("Slippage Modifiable");
  }
  if (s.external_call === true) {
    score -= 20;
    factors.push("External Call");
  }

  if (s.owner_change_balance === true) {
    score -= 10;
    factors.push("Owner Can Change Balance");
  }
  if (s.hidden_owner === true) {
    score -= 10;
    factors.push("Hidden Owner");
  }
  if (s.cannot_buy === true) {
    score -= 10;
    factors.push("Cannot Buy");
  }
  if (s.trading_cooldown === true) {
    score -= 10;
    factors.push("Trading Cooldown");
  }

  if (s.is_open_source === false) {
    score -= 5;
    factors.push("Not Open Source");
  }
  if (s.is_mintable === true) {
    score -= 5;
    factors.push("Mintable");
  }
  if (s.take_back_ownership === true) {
    score -= 5;
    factors.push("Take Back Ownership");
  }

  const finalScore = clampScore(score);
  const isRisk = finalScore < 60 || factors.length > 0;
  return { safety_score: finalScore, is_security_risk: isRisk, risk_factors: factors };
}

function checksStateFromScoring(signals: GoPlusSignals, scored: { risk_factors: string[] }): ChecksState {
  if (signals.status === "unsupported") return "unsupported";
  if (signals.status === "scanning") return "pending";
  const rf = scored.risk_factors ?? [];
  if (rf.includes("Unknown Risk (GoPlus missing fields)") || rf.includes("Unknown Risk (GoPlus unavailable)")) return "limited";
  return "complete";
}

function normalizeGoPlusStatus(
  raw: GoPlusSignals["status"],
  checksState: ChecksState,
): GoPlusSignals["status"] | "limited" {
  if (checksState === "pending") return "pending";
  if (checksState === "limited") return "limited";
  return raw;
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

function officialWebsiteUrl(pair: Pair): string | null {
  const w = pair.info?.websites;
  const u0 = Array.isArray(w) && w.length ? w[0]?.url : undefined;
  return typeof u0 === "string" && u0.trim() ? u0.trim() : null;
}

function dexChartUrl(pair: Pair): string | null {
  const u = pair.url;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

function socialUrl(pair: Pair, kind: "twitter" | "telegram"): string | null {
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
        const official = officialWebsiteUrl(best);
        const chart = dexChartUrl(best);
        const twitter = socialUrl(best, "twitter");
        const telegram = socialUrl(best, "telegram");
        upRows.push({
          token_id: x.token_id,
          chain_id: chainId,
          token_address: x.token_address,
          symbol: best.baseToken?.symbol ?? null,
          logo_url: (best.info as any)?.imageUrl ?? null,
          // Backward compatibility: website_url == official website (nullable)
          website_url: official,
          official_website_url: official,
          dex_chart_url: chart,
          twitter_url: twitter,
          telegram_url: telegram,
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
          const cannot_sell_all = flag(
            (resObj as any)["cannot_sell_all"] ??
              (resObj as any)["cannotSellAll"] ??
              (resObj as any)["cannot_sell"] ??
              (resObj as any)["cannotSell"],
          );
          const is_honeypot = flag((resObj as any)["is_honeypot"] ?? (resObj as any)["isHoneypot"]);
          const is_proxy = flag((resObj as any)["is_proxy"] ?? (resObj as any)["isProxy"]);
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

          goByToken.set(`${chainId}:${a}`.toLowerCase(), {
            status: "live",
            scanned_at: nowIso,
            cannot_sell,
            cannot_sell_all,
            is_honeypot,
            is_proxy,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
            transfer_pausable,
            slippage_modifiable,
            external_call,
            owner_change_balance,
            hidden_owner,
            cannot_buy,
            trading_cooldown,
            is_open_source,
            is_mintable,
            take_back_ownership,
          });

          upRows.push({
            chain_id: chainId,
            token_address: a,
            raw: payload,
            scanned_at: nowIso,
            cannot_sell,
            cannot_sell_all,
            is_honeypot,
            is_proxy,
            buy_tax,
            sell_tax,
            trust_list,
            is_blacklisted,
            transfer_pausable,
            slippage_modifiable,
            external_call,
            owner_change_balance,
            hidden_owner,
            cannot_buy,
            trading_cooldown,
            is_open_source,
            is_mintable,
            take_back_ownership,
          });
        }

        if (upRows.length) await supabase.from("goplus_token_security_cache").upsert(upRows, { onConflict: "chain_id,token_address" });
      }
    }),
  );

  // Load latest token snapshots for response (after Dex refresh)
  const latestTokens = await supabase
    .from("tokens")
    .select(
      "token_id,chain_id,token_address,symbol,logo_url,price_usd,price_change_5m,price_change_1h,updated_at,official_website_url,dex_chart_url,twitter_url,telegram_url",
    )
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
    const signals: GoPlusSignals = {
      status,
      is_honeypot: (go as any).is_honeypot ?? null,
      is_blacklisted: (go as any).is_blacklisted ?? null,
      cannot_sell_all: (go as any).cannot_sell_all ?? null,
      buy_tax: num((go as any).buy_tax),
      sell_tax: num((go as any).sell_tax),
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
    const scored = scoreDeductionModel(signals);
    const checks_state = checksStateFromScoring(signals, scored);
    const goplus_status = normalizeGoPlusStatus(status, checks_state);
    return {
      token_id: w.token_id,
      chain_id: chainId || (t?.chain_id ?? null),
      token_address: tokenAddr || (t?.token_address ?? null),
      symbol: t?.symbol ?? null,
      logo_url: t?.logo_url ?? null,
      official_website_url: t?.official_website_url ?? null,
      dex_chart_url: t?.dex_chart_url ?? null,
      twitter_url: t?.twitter_url ?? null,
      telegram_url: t?.telegram_url ?? null,
      captured_price: w.captured_price,
      captured_at: w.captured_at,
      current_price: currentPrice,
      roi_since_captured: roiSinceCaptured(currentPrice, w.captured_price),
      price_change_5m: t?.price_change_5m ?? null,
      price_change_1h: t?.price_change_1h ?? null,
      is_surging: t?.price_change_5m !== null && t?.price_change_1h !== null ? t.price_change_5m > t.price_change_1h : false,
      goplus_status,
      checks_state,
      goplus_is_honeypot: signals.is_honeypot,
      goplus_is_blacklisted: signals.is_blacklisted,
      goplus_cannot_sell_all: signals.cannot_sell_all,
      goplus_buy_tax: signals.buy_tax,
      goplus_sell_tax: signals.sell_tax,
      goplus_is_proxy: signals.is_proxy,
      goplus_transfer_pausable: signals.transfer_pausable,
      goplus_slippage_modifiable: signals.slippage_modifiable,
      goplus_external_call: signals.external_call,
      goplus_owner_change_balance: signals.owner_change_balance,
      goplus_hidden_owner: signals.hidden_owner,
      goplus_cannot_buy: signals.cannot_buy,
      goplus_trading_cooldown: signals.trading_cooldown,
      goplus_is_open_source: signals.is_open_source,
      goplus_is_mintable: signals.is_mintable,
      goplus_take_back_ownership: signals.take_back_ownership,
      goplus_trust_list: (go as any).trust_list ?? null,
      safety_score: scored.safety_score,
      is_security_risk: scored.is_security_risk,
      risk_factors: scored.risk_factors,
      updated_at: t?.updated_at ?? new Date(0).toISOString(),
      urls: {
        official_website: t?.official_website_url ?? null,
        dex_chart: t?.dex_chart_url ?? null,
        twitter: t?.twitter_url ?? null,
        telegram: t?.telegram_url ?? null,
      },
    };
  });

  return json({ items: out, limit, refreshed: { requested: staleTargets.length, updated: updatedCount } });
});

