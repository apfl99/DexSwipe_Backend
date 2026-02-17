import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

type Profile = Record<string, unknown> & {
  chainId?: string;
  tokenAddress?: string;
};

type SearchResponse = Record<string, unknown> & {
  pairs?: unknown[];
};

type SearchPair = Record<string, unknown> & {
  chainId?: string;
  baseToken?: { address?: string };
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

const PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const SEARCH_URL = "https://api.dexscreener.com/latest/dex/search";

const ALWAYS_CHAINS = ["solana", "base"];
const ROTATING_CHAINS = ["sui", "tron"] as const;

function decideTargets(now: Date): { mode: "rotate"; chains: string[]; rotating: string } {
  // Always fetch Solana/Base, and rotate Sui/Tron 1:1 per run.
  // Deterministic: based on epoch 5-minute bucket.
  const bucket = Math.floor(now.getTime() / (5 * 60 * 1000));
  const rotating = ROTATING_CHAINS[bucket % ROTATING_CHAINS.length];
  return { mode: "rotate", chains: [...ALWAYS_CHAINS, rotating], rotating };
}

async function fetchRotatingCandidates(rotating: string): Promise<Array<{ chain_id: string; token_address: string }>> {
  // DexScreener global latest feeds don't reliably include Sui/Tron.
  // For rotating chains we use the search endpoint and filter by chainId.
  const tryQueries =
    rotating === "tron"
      ? ["tron", "usdt"] // fallback query known to surface tron pairs
      : [rotating]; // sui

  for (const q of tryQueries) {
    const payload = (await fetchJsonWithRetry(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, {
      maxAttempts: 3,
      timeoutMs: 15_000,
    })) as SearchResponse;

    const pairs = Array.isArray(payload?.pairs) ? (payload.pairs as SearchPair[]) : [];
    const out: Array<{ chain_id: string; token_address: string }> = [];
    for (const p of pairs) {
      const chainId = p.chainId;
      const addr = p.baseToken?.address;
      if (typeof chainId !== "string" || typeof addr !== "string") continue;
      if (chainId !== rotating) continue;
      out.push({ chain_id: chainId, token_address: addr });
    }
    if (out.length) return out;
  }
  return [];
}

Deno.serve(async (req) => {
  try {
    const expectedSecret = Deno.env.get("DEXSWIPE_CRON_SECRET") ?? "";
    if (expectedSecret) {
      const provided = req.headers.get("x-cron-secret") ?? "";
      if (provided !== expectedSecret) return json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const forced = (url.searchParams.get("force_rotating") ?? "").trim().toLowerCase();

    const now = new Date();
    const { chains, rotating } =
      forced === "sui" || forced === "tron"
        ? { chains: [...ALWAYS_CHAINS, forced], rotating: forced }
        : decideTargets(now);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const payload = await fetchJsonWithRetry(PROFILES_URL, { maxAttempts: 3, timeoutMs: 15_000 });
    if (!Array.isArray(payload)) return json({ ok: false, error: "unexpected response" }, { status: 500 });

    const profileRows = (payload as Profile[])
      .map((p) => ({ chain_id: p.chainId ?? null, token_address: p.tokenAddress ?? null }))
      .filter((r) => typeof r.chain_id === "string" && typeof r.token_address === "string") as Array<{
      chain_id: string;
      token_address: string;
    }>;

    // Always-chains: from profiles feed.
    const allowedAlways = new Set(ALWAYS_CHAINS);
    const alwaysRows = profileRows.filter((r) => allowedAlways.has(r.chain_id));

    // Rotating chain: from search feed (best-effort).
    const rotatingRows = await fetchRotatingCandidates(rotating);

    const rows = [...alwaysRows, ...rotatingRows];

    // Cap per chain to keep queue/worker fast on free-tier.
    const allowed = new Set(chains);
    const capPerChain = 40;
    const perChainCounts = new Map<string, number>();
    const dedup = new Map<string, { chain_id: string; token_address: string }>();
    for (const r of rows) {
      if (!allowed.has(r.chain_id)) continue;
      const k = `${r.chain_id}:${r.token_address}`;
      if (dedup.has(k)) continue;
      const c = perChainCounts.get(r.chain_id) ?? 0;
      if (c >= capPerChain) continue;
      perChainCounts.set(r.chain_id, c + 1);
      dedup.set(k, r);
      if (dedup.size >= capPerChain * chains.length) break;
    }
    const queueRows = Array.from(dedup.values());
    if (queueRows.length) {
      const up = await supabase
        .from("dexscreener_market_update_queue")
        .upsert(queueRows, { onConflict: "chain_id,token_address", ignoreDuplicates: true });
      if (up.error) return json({ ok: false, error: up.error.message }, { status: 500 });
    }

    const enqCounts: Record<string, number> = {};
    for (const r of queueRows) enqCounts[r.chain_id] = (enqCounts[r.chain_id] ?? 0) + 1;

    return json({
      ok: true,
      mode: "always+rotate",
      minute: now.getMinutes(),
      rotating_chain: rotating,
      enqueued_market_updates: queueRows.length,
      enqueued_by_chain: enqCounts,
      chains,
      caps: { cap_per_chain: capPerChain },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : null;
    return json({ ok: false, error: msg, stack }, { status: 500 });
  }
});

