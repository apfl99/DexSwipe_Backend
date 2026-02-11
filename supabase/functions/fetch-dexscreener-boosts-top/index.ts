import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

type BoostTop = Record<string, unknown> & {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

const URL = "https://api.dexscreener.com/token-boosts/top/v1";

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

  const startedAt = new Date();
  const run = await supabase
    .from("dexscreener_ingestion_runs")
    .insert({
      status: "running",
      started_at: startedAt.toISOString(),
      source: "dexscreener",
      endpoint: "/token-boosts/top/v1",
    })
    .select("id")
    .single();
  const runId = run.data?.id as string | undefined;
  if (run.error || !runId) {
    return json({ error: "failed to create run row", details: run.error }, { status: 500 });
  }

  try {
    const payload = await fetchJsonWithRetry(URL);
    const items: BoostTop[] = Array.isArray(payload) ? (payload as BoostTop[]) : ([payload as BoostTop] as BoostTop[]);

    const rows = items
      .map((b) => ({
        chain_id: b.chainId ?? null,
        token_address: b.tokenAddress ?? null,
        raw: b,
        amount: typeof b.amount === "number" ? b.amount : null,
        total_amount: typeof b.totalAmount === "number" ? b.totalAmount : null,
        fetched_at: startedAt.toISOString(),
        updated_at: startedAt.toISOString(),
        last_run_id: runId,
      }))
      .filter((r) => typeof r.chain_id === "string" && typeof r.token_address === "string");

    // Dedup within payload
    const deduped = new Map<string, typeof rows[number]>();
    for (const r of rows) deduped.set(`${r.chain_id}:${r.token_address}`, r);
    const finalRows = [...deduped.values()];

    if (finalRows.length) {
      const up = await supabase.from("dexscreener_token_boosts_top_raw").upsert(finalRows, { onConflict: "chain_id,token_address" });
      if (up.error) throw new Error(up.error.message);

      // Enqueue market updates (base/solana only for now)
      const marketChains = new Set(["solana", "base"]);
      const qRows = finalRows
        .filter((r) => marketChains.has(r.chain_id as string))
        .map((r) => ({ chain_id: r.chain_id as string, token_address: r.token_address as string }));
      if (qRows.length) {
        const mq = await supabase
          .from("dexscreener_market_update_queue")
          .upsert(qRows, { onConflict: "chain_id,token_address", ignoreDuplicates: true });
        if (mq.error) throw new Error(`enqueue market failed: ${mq.error.message}`);
      }
    }

    await supabase
      .from("dexscreener_ingestion_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        fetched_count: items.length,
        upserted_count: finalRows.length,
      })
      .eq("id", runId);

    return json({ ok: true, fetched: items.length, stored: finalRows.length, run_id: runId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("dexscreener_ingestion_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg })
      .eq("id", runId);
    return json({ ok: false, error: msg, run_id: runId }, { status: 500 });
  }
});

