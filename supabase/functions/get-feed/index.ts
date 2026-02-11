import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

type FeedItem = {
  chain_id: string;
  token_address: string;
  fetched_at: string;
  profile: unknown;
  boost: unknown | null;
  takeover: unknown | null;
  market: {
    price_usd: number | null;
    liquidity_usd: number | null;
    volume_24h: number | null;
    fdv: number | null;
    market_cap: number | null;
    updated_at: string;
    raw_best_pair: unknown;
  } | null;
  quality: {
    website_url: string | null;
    url_risk: {
      is_phishing: boolean | null;
      dapp_risk_level: string | null;
      scanned_at: string | null;
    } | null;
    rugpull: {
      is_rugpull_risk: boolean | null;
      risk_level: string | null;
      scanned_at: string | null;
    } | null;
  } | null;
  security: {
    always_deny: boolean;
    deny_reasons: string[];
    scanned_at: string | null;
  } | null;
};

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

async function restGetJson(
  baseUrl: string,
  serviceRoleKey: string,
  pathAndQuery: string,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${pathAndQuery}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`rest GET ${pathAndQuery} failed: HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);
  const offset = Math.max(Number.parseInt(u.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const chains = parseChains(u.searchParams.get("chains"));
  const minLiquidityUsd = parseNum(u.searchParams.get("min_liquidity_usd"));
  const minVolume24h = parseNum(u.searchParams.get("min_volume_24h"));
  const minFdv = parseNum(u.searchParams.get("min_fdv"));
  const hasMarketFilter = minLiquidityUsd !== null || minVolume24h !== null || minFdv !== null;
  const includeRisky = (u.searchParams.get("include_risky") ?? "").toLowerCase() === "true";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // 1) Choose base set
  // - No market filters: newest profiles first (fast, UX-friendly)
  // - With market filters: market table first (so filters work reliably)
  let baseTokens: Array<{ chain_id: string; token_address: string; fetched_at: string; raw: unknown }> = [];

  if (!hasMarketFilter) {
    const windowSize = Math.min(limit * 10, 500);
    let q = supabase
      .from("dexscreener_token_profiles_raw")
      .select("chain_id,token_address,raw,fetched_at")
      .order("fetched_at", { ascending: false })
      .range(offset, offset + windowSize - 1);
    if (chains) q = q.in("chain_id", chains);

    const profilesRes = await q;
    if (profilesRes.error) return json({ error: profilesRes.error.message }, { status: 500 });
    baseTokens = (profilesRes.data ?? []) as typeof baseTokens;
  } else {
    // Use PostgREST directly for market-first (more reliable for numeric filters in edge runtime).
    const qs: string[] = [
      "select=chain_id,token_address,updated_at",
      "order=liquidity_usd.desc.nullslast",
      `offset=${offset}`,
      `limit=${limit * 5}`,
    ];
    if (chains && chains.length) {
      const list = chains.map((c) => encodeURIComponent(c.replaceAll(",", ""))).join(",");
      qs.push(`chain_id=in.(${list})`);
    }
    if (minLiquidityUsd !== null) qs.push(`liquidity_usd=gte.${encodeURIComponent(String(minLiquidityUsd))}`);
    if (minVolume24h !== null) qs.push(`volume_24h=gte.${encodeURIComponent(String(minVolume24h))}`);
    if (minFdv !== null) qs.push(`fdv=gte.${encodeURIComponent(String(minFdv))}`);

    try {
      const data = await restGetJson(supabaseUrl, serviceRoleKey, `/rest/v1/dexscreener_token_market_data?${qs.join("&")}`);
      const rows = Array.isArray(data) ? (data as Array<{ chain_id: string; token_address: string; updated_at: string }>) : [];
      baseTokens = rows.map((r) => ({
        chain_id: r.chain_id,
        token_address: r.token_address,
        fetched_at: r.updated_at,
        raw: null,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, { status: 500 });
    }
  }

  if (baseTokens.length === 0) {
    return json({ tokens: [], next_offset: offset, limit });
  }

  // 2) Batch load profiles/boosts/takeovers/market/security for these tokens (best-effort, per-chain).
  // If market-first mode, we must load profile raw now.
  const byChain = new Map<string, string[]>();
  for (const p of baseTokens) {
    const arr = byChain.get(p.chain_id) ?? [];
    arr.push(p.token_address);
    byChain.set(p.chain_id, arr);
  }

  const profilesMap = new Map<string, { raw: unknown; fetched_at: string }>();
  for (const [chain, addrs] of byChain.entries()) {
    const pr = await supabase
      .from("dexscreener_token_profiles_raw")
      .select("chain_id,token_address,raw,fetched_at")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!pr.error) {
      for (const r of (pr.data ?? []) as Array<{ chain_id: string; token_address: string; raw: unknown; fetched_at: string }>) {
        profilesMap.set(`${r.chain_id}:${r.token_address}`, { raw: r.raw, fetched_at: r.fetched_at });
      }
    }
  }

  // Rebuild baseTokens with actual profile data (drop ones missing profile)
  const profiles = baseTokens
    .map((t) => {
      const p = profilesMap.get(`${t.chain_id}:${t.token_address}`);
      if (!p) return null;
      return { chain_id: t.chain_id, token_address: t.token_address, raw: p.raw, fetched_at: p.fetched_at };
    })
    .filter(Boolean) as Array<{ chain_id: string; token_address: string; raw: unknown; fetched_at: string }>;

  if (profiles.length === 0) {
    return json({ tokens: [], next_offset: offset, limit });
  }

  // 3) Batch load boosts/takeovers/market/security
  const byChain2 = new Map<string, string[]>();
  for (const p of profiles) {
    const arr = byChain2.get(p.chain_id) ?? [];
    arr.push(p.token_address);
    byChain2.set(p.chain_id, arr);
  }

  const boosts = new Map<string, unknown>();
  const takeovers = new Map<string, unknown>();
  const markets = new Map<string, FeedItem["market"]>();
  const security = new Map<string, { always_deny: boolean; deny_reasons: string[]; scanned_at: string | null }>();
  const rugpull = new Map<string, { is_rugpull_risk: boolean | null; risk_level: string | null; scanned_at: string | null }>();
  const urlRisk = new Map<string, { is_phishing: boolean | null; dapp_risk_level: string | null; scanned_at: string | null }>();
  const websiteUrlByToken = new Map<string, string>();

  for (const [chain, addrs] of byChain2.entries()) {
    const b = await supabase
      .from("dexscreener_token_boosts_raw")
      .select("chain_id,token_address,raw,amount,total_amount")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!b.error) {
      for (const r of (b.data ?? []) as Array<{ chain_id: string; token_address: string; raw: unknown }>) {
        boosts.set(`${r.chain_id}:${r.token_address}`, r.raw);
      }
    }

    const t = await supabase
      .from("dexscreener_community_takeovers_raw")
      .select("chain_id,token_address,raw,claim_date")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!t.error) {
      for (const r of (t.data ?? []) as Array<{ chain_id: string; token_address: string; raw: unknown }>) {
        takeovers.set(`${r.chain_id}:${r.token_address}`, r.raw);
      }
    }

    const m = await supabase
      .from("dexscreener_token_market_data")
      .select("chain_id,token_address,price_usd,liquidity_usd,volume_24h,fdv,market_cap,updated_at,raw_best_pair")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!m.error) {
      for (const r of (m.data ?? []) as Array<{
        chain_id: string;
        token_address: string;
        price_usd: number | null;
        liquidity_usd: number | null;
        volume_24h: number | null;
        fdv: number | null;
        market_cap: number | null;
        updated_at: string;
        raw_best_pair: unknown;
      }>) {
        markets.set(`${r.chain_id}:${r.token_address}`, {
          price_usd: r.price_usd ?? null,
          liquidity_usd: r.liquidity_usd ?? null,
          volume_24h: r.volume_24h ?? null,
          fdv: r.fdv ?? null,
          market_cap: r.market_cap ?? null,
          updated_at: r.updated_at,
          raw_best_pair: r.raw_best_pair,
        });

        // Extract first website url from raw_best_pair.info.websites
        const websites = (r.raw_best_pair as any)?.info?.websites;
        if (Array.isArray(websites) && websites.length) {
          const u0 = (websites[0] as any)?.url;
          if (typeof u0 === "string" && u0.trim()) {
            websiteUrlByToken.set(`${r.chain_id}:${r.token_address}`, u0.trim());
          }
        }
      }
    }

    const s = await supabase
      .from("goplus_token_security_cache")
      .select("chain_id,token_address,always_deny,deny_reasons,scanned_at")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!s.error) {
      for (const r of (s.data ?? []) as Array<{
        chain_id: string;
        token_address: string;
        always_deny: boolean;
        deny_reasons: string[];
        scanned_at: string | null;
      }>) {
        security.set(`${r.chain_id}:${r.token_address}`, {
          always_deny: r.always_deny,
          deny_reasons: r.deny_reasons ?? [],
          scanned_at: r.scanned_at ?? null,
        });
      }
    }

    const rp = await supabase
      .from("goplus_rugpull_cache")
      .select("chain_id,token_address,is_rugpull_risk,risk_level,scanned_at")
      .eq("chain_id", chain)
      .in("token_address", addrs);
    if (!rp.error) {
      for (const r of (rp.data ?? []) as Array<{
        chain_id: string;
        token_address: string;
        is_rugpull_risk: boolean | null;
        risk_level: string | null;
        scanned_at: string | null;
      }>) {
        rugpull.set(`${r.chain_id}:${r.token_address}`, {
          is_rugpull_risk: r.is_rugpull_risk ?? null,
          risk_level: r.risk_level ?? null,
          scanned_at: r.scanned_at ?? null,
        });
      }
    }
  }

  // Batch-load URL risk cache for website urls
  const websiteUrls = [...new Set([...websiteUrlByToken.values()])];
  if (websiteUrls.length) {
    const ur = await supabase
      .from("goplus_url_risk_cache")
      .select("url,is_phishing,dapp_risk_level,scanned_at")
      .in("url", websiteUrls);
    if (!ur.error) {
      for (const r of (ur.data ?? []) as Array<{ url: string; is_phishing: boolean | null; dapp_risk_level: string | null; scanned_at: string | null }>) {
        urlRisk.set(r.url, {
          is_phishing: r.is_phishing ?? null,
          dapp_risk_level: r.dapp_risk_level ?? null,
          scanned_at: r.scanned_at ?? null,
        });
      }
    }
  }

  // 4) Compose items and exclude always_deny / apply market filters; finally take `limit`.
  const items: FeedItem[] = [];
  for (const p of profiles) {
    const key = `${p.chain_id}:${p.token_address}`;
    const sec = security.get(key) ?? null;
    if (sec?.always_deny) continue;
    const market = markets.get(key) ?? null;
    const websiteUrl = websiteUrlByToken.get(key) ?? null;
    const uRisk = websiteUrl ? (urlRisk.get(websiteUrl) ?? null) : null;
    const rp = rugpull.get(key) ?? null;

    // Default: exclude obvious risky items unless explicitly included.
    const isPhishing = uRisk?.is_phishing === true;
    const isRugpull = rp?.is_rugpull_risk === true;
    if (!includeRisky && (isPhishing || isRugpull)) continue;

    // If market filters are requested, require market data presence.
    if (hasMarketFilter && !market) continue;
    if (minLiquidityUsd !== null && (market?.liquidity_usd ?? 0) < minLiquidityUsd) continue;
    if (minVolume24h !== null && (market?.volume_24h ?? 0) < minVolume24h) continue;
    if (minFdv !== null && (market?.fdv ?? 0) < minFdv) continue;

    items.push({
      chain_id: p.chain_id,
      token_address: p.token_address,
      fetched_at: p.fetched_at,
      profile: p.raw,
      boost: boosts.get(key) ?? null,
      takeover: takeovers.get(key) ?? null,
      market,
      quality: {
        website_url: websiteUrl,
        url_risk: uRisk,
        rugpull: rp,
      },
      security: sec,
    });

    if (items.length >= limit) break;
  }

  return json({
    tokens: items,
    limit,
    next_offset: offset + limit,
    notes: {
      pagination: "offset/limit (can be upgraded to keyset cursor later)",
      security_filter: "always_deny tokens are excluded",
      market_filters: {
        min_liquidity_usd: minLiquidityUsd,
        min_volume_24h: minVolume24h,
        min_fdv: minFdv,
      },
    },
  });
});

