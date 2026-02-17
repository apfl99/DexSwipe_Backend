import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

type Profile = Record<string, unknown> & {
  chainId?: string;
  tokenAddress?: string;
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

const URL = "https://api.dexscreener.com/token-profiles/latest/v1";

const PRIMARY_CHAINS = ["solana", "base"];
const SECONDARY_CHAINS = ["sui", "tron"];

function decideTargets(minute: number): { tier: "primary" | "secondary" | "skip"; chains: string[] } {
  const mod = minute % 10;
  if (mod === 0) return { tier: "primary", chains: PRIMARY_CHAINS };
  if (mod === 5) return { tier: "secondary", chains: SECONDARY_CHAINS };
  return { tier: "skip", chains: [] };
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get("DEXSWIPE_CRON_SECRET") ?? "";
  if (expectedSecret) {
    const provided = req.headers.get("x-cron-secret") ?? "";
    if (provided !== expectedSecret) return json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const { tier, chains } = decideTargets(now.getMinutes());
  if (tier === "skip") {
    return json({ ok: true, skipped: true, reason: "not_rotation_minute", minute: now.getMinutes() });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const payload = await fetchJsonWithRetry(URL, { maxAttempts: 3, timeoutMs: 15_000 });
  if (!Array.isArray(payload)) return json({ ok: false, error: "unexpected response" }, { status: 500 });

  const rows = (payload as Profile[])
    .map((p) => ({ chain_id: p.chainId ?? null, token_address: p.tokenAddress ?? null }))
    .filter((r) => typeof r.chain_id === "string" && typeof r.token_address === "string") as Array<{
    chain_id: string;
    token_address: string;
  }>;

  const allowed = new Set(chains);
  const dedup = new Map<string, { chain_id: string; token_address: string }>();
  for (const r of rows) {
    if (!allowed.has(r.chain_id)) continue;
    dedup.set(`${r.chain_id}:${r.token_address}`, r);
    if (dedup.size >= 120) break; // cap to keep function fast
  }
  const queueRows = [...dedup.values()];
  if (queueRows.length) {
    const up = await supabase
      .from("dexscreener_market_update_queue")
      .upsert(queueRows, { onConflict: "chain_id,token_address", ignoreDuplicates: true });
    if (up.error) return json({ ok: false, error: up.error.message }, { status: 500 });
  }

  return json({ ok: true, tier, minute: now.getMinutes(), enqueued_market_updates: queueRows.length, chains });
});

