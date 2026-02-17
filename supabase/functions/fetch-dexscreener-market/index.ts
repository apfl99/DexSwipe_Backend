import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

type Pair = Record<string, unknown> & {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  priceChange?: Record<string, number>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: Array<{ url?: string }> };
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function volume24h(pair: Pair): number | null {
  const v = pair.volume;
  if (!v || typeof v !== "object") return null;
  // DexScreener uses keys like h24; keep robust
  return num((v as Record<string, unknown>)["h24"] ?? (v as Record<string, unknown>)["24h"]);
}

function pickBestPair(pairs: Pair[], tokenAddr: string): Pair | null {
  const lower = tokenAddr.toLowerCase();
  const relevant = pairs.filter((p) => {
    const b = p.baseToken?.address?.toLowerCase();
    const q = p.quoteToken?.address?.toLowerCase();
    return b === lower || q === lower;
  });
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0));
  return relevant[0];
}

function int(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function webp(url: string | null): string | null {
  if (!url) return null;
  // Best-effort: force webp when the CDN supports it.
  if (url.includes("format=auto")) return url.replace("format=auto", "format=webp");
  return url;
}

function websiteUrl(pair: Pair): string | null {
  const w = pair.info?.websites;
  const u0 = Array.isArray(w) && w.length ? w[0]?.url : undefined;
  return typeof u0 === "string" && u0.trim() ? u0.trim() : null;
}

const MAX_JOBS_PER_INVOCATION = 120; // yields up to 4 calls/chain if chunk=30

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get("DEXSWIPE_CRON_SECRET") ?? "";
  if (expectedSecret) {
    const provided = req.headers.get("x-cron-secret") ?? "";
    if (provided !== expectedSecret) return json({ error: "unauthorized" }, { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Gate GoPlus scans by market quality (reduce CU usage; increase data quality).
  const scanMinLiquidityUsd = (() => {
    const v = Deno.env.get("SECURITY_ENQUEUE_MIN_LIQUIDITY_USD") ?? "5000";
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 5000;
  })();
  const scanMinVolume24h = (() => {
    const v = Deno.env.get("SECURITY_ENQUEUE_MIN_VOLUME_24H") ?? "10000";
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 10000;
  })();

  // Hype filter: keep DB lean by only persisting tokens meeting quality threshold.
  const hypeMinLiquidityUsd = (() => {
    const v = Deno.env.get("HYPE_MIN_LIQUIDITY_USD") ?? "10000";
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 10000;
  })();
  const hypeMinTxns1h = (() => {
    const v = Deno.env.get("HYPE_MIN_TXNS_1H") ?? "10";
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 10;
  })();

  const supportedChainsRes = await supabase.from("chain_mappings").select("dexscreener_chain_id");
  const supportedSecurityChains = new Set<string>(
    !supportedChainsRes.error ? (supportedChainsRes.data ?? []).map((r: any) => r.dexscreener_chain_id) : [],
  );

  const processed: Array<{ chain_id: string; token_address: string; ok: boolean; error?: string }> = [];
  let total = 0;

  while (total < MAX_JOBS_PER_INVOCATION) {
    const dq = await supabase.rpc("dequeue_market_updates", { batch_size: 60 });
    if (dq.error) return json({ error: "dequeue failed", details: dq.error }, { status: 500 });
    const jobs = (dq.data ?? []) as Array<{ chain_id: string; token_address: string; attempts: number }>;
    if (jobs.length === 0) break;

    // group by chain and chunk 30 addresses per API call
    const byChain = new Map<string, Array<{ token: string; attempts: number }>>();
    for (const j of jobs) {
      const arr = byChain.get(j.chain_id) ?? [];
      arr.push({ token: j.token_address, attempts: j.attempts ?? 0 });
      byChain.set(j.chain_id, arr);
    }

    for (const [chain, items] of byChain.entries()) {
      for (let i = 0; i < items.length; i += 30) {
        const chunk = items.slice(i, i + 30);
        total += chunk.length;
        const addrs = chunk.map((x) => x.token).join(",");
        const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(addrs)}`;

        try {
          const payload = await fetchJsonWithRetry(url, { maxAttempts: 3, timeoutMs: 20_000 });
          if (!Array.isArray(payload)) throw new Error("tokens/v1 response is not an array");
          const pairs = payload as Pair[];

          // For each token in chunk, pick best pair and upsert market data
          for (const it of chunk) {
            const best = pickBestPair(pairs, it.token);
            if (!best) {
              // mark completed with longer retry
              await supabase
                .from("dexscreener_market_update_queue")
                .update({
                  status: "completed",
                  locked_at: null,
                  updated_at: new Date().toISOString(),
                  last_error: "no_pair_found",
                  last_fetched_at: new Date().toISOString(),
                  next_run_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
                })
                .eq("chain_id", chain)
                .eq("token_address", it.token);
              processed.push({ chain_id: chain, token_address: it.token, ok: true });
              continue;
            }

            const price_usd = num(best.priceUsd);
            const liquidity_usd = num(best.liquidity?.usd);
            const volume_24h = volume24h(best);
            const fdv = num(best.fdv);
            const market_cap = num(best.marketCap);

            await supabase
              .from("dexscreener_market_update_queue")
              .update({
                status: "completed",
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: null,
                last_fetched_at: new Date().toISOString(),
                // refresh market more frequently than GoPlus; 30m default
                next_run_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              })
              .eq("chain_id", chain)
              .eq("token_address", it.token);

            // Release tokens table upsert (denormalized fields for fast get-feed).
            const price_change_1h = num((best.priceChange as any)?.h1);
            const buys_24h = int((best.txns as any)?.h24?.buys);
            const sells_24h = int((best.txns as any)?.h24?.sells);
            const buys_1h = int((best.txns as any)?.h1?.buys) ?? 0;
            const sells_1h = int((best.txns as any)?.h1?.sells) ?? 0;
            const txns_1h = buys_1h + sells_1h;
            const pairCreatedAtMs = int(best.pairCreatedAt);
            const pair_created_at = pairCreatedAtMs ? new Date(pairCreatedAtMs).toISOString() : null;
            const tokenId = `${chain}:${it.token}`;

            // Apply hype filter before persisting into the lean `tokens` table.
            const liqForHype = liquidity_usd ?? 0;
            if (liqForHype >= hypeMinLiquidityUsd && txns_1h > hypeMinTxns1h) {
              const tokensUp = await supabase.from("tokens").upsert(
                {
                  token_id: tokenId,
                  chain_id: chain,
                  token_address: it.token,
                  name: (best.baseToken as any)?.name ?? null,
                  symbol: (best.baseToken as any)?.symbol ?? null,
                  logo_url: webp((best.info as any)?.imageUrl ?? null),
                  website_url: websiteUrl(best),
                  price_usd,
                  liquidity_usd,
                  volume_24h,
                  fdv,
                  market_cap,
                  price_change_1h,
                  buys_24h,
                  sells_24h,
                  pair_created_at,
                  last_fetched_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "chain_id,token_address" },
              );
              if (tokensUp.error) throw new Error(`tokens upsert failed: ${tokensUp.error.message}`);
            }

            // Enqueue GoPlus scan only for tokens passing quality gate.
            const liq = liquidity_usd ?? 0;
            const vol = volume_24h ?? 0;
            if (supportedSecurityChains.has(chain) && liq >= scanMinLiquidityUsd && vol >= scanMinVolume24h) {
              await supabase
                .from("token_security_scan_queue")
                .upsert(
                  { chain_id: chain, token_address: it.token },
                  { onConflict: "chain_id,token_address", ignoreDuplicates: true },
                );
            }

            // Enqueue GoPlus quality scans (URL phishing/dapp + EVM rugpull) for same gated tokens.
            if (liq >= scanMinLiquidityUsd && vol >= scanMinVolume24h) {
              await supabase
                .from("token_quality_scan_queue")
                .upsert(
                  { chain_id: chain, token_address: it.token },
                  { onConflict: "chain_id,token_address", ignoreDuplicates: true },
                );
            }

            processed.push({ chain_id: chain, token_address: it.token, ok: true });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // mark all chunk items failed with backoff
          for (const it of chunk) {
            const attempts = (it.attempts ?? 0) + 1;
            const backoffMs = Math.min(2 * 60 * 1000 * 2 ** Math.min(attempts, 6), 60 * 60 * 1000);
            await supabase
              .from("dexscreener_market_update_queue")
              .update({
                status: "failed",
                attempts,
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: msg,
                next_run_at: new Date(Date.now() + backoffMs).toISOString(),
              })
              .eq("chain_id", chain)
              .eq("token_address", it.token);
            processed.push({ chain_id: chain, token_address: it.token, ok: false, error: msg });
          }
        }
      }
    }
  }

  return json({ ok: true, processed_count: processed.length, processed });
});

