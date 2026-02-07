import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

type Boost = Record<string, unknown> & {
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

const URL = "https://api.dexscreener.com/token-boosts/latest/v1";

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
      endpoint: "/token-boosts/latest/v1",
    })
    .select("id")
    .single();
  const runId = run.data?.id as string | undefined;
  if (run.error || !runId) {
    return json({ error: "failed to create run row", details: run.error }, { status: 500 });
  }

  try {
    const payload = await fetchJsonWithRetry(URL);
    const boosts: Boost[] = Array.isArray(payload) ? payload as Boost[] : [payload as Boost];

    const rows = boosts
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

    // Deduplicate within the same payload to avoid:
    // "ON CONFLICT DO UPDATE command cannot affect row a second time"
    const deduped = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      deduped.set(`${r.chain_id}:${r.token_address}`, r);
    }
    const finalRows = [...deduped.values()];

    if (finalRows.length) {
      const up = await supabase
        .from("dexscreener_token_boosts_raw")
        .upsert(finalRows, { onConflict: "chain_id,token_address" });
      if (up.error) throw new Error(up.error.message);
    }

    await supabase
      .from("dexscreener_ingestion_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        fetched_count: boosts.length,
        upserted_count: finalRows.length,
      })
      .eq("id", runId);

    return json({ ok: true, fetched: boosts.length, stored: finalRows.length, run_id: runId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("dexscreener_ingestion_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg })
      .eq("id", runId);
    return json({ ok: false, error: msg, run_id: runId }, { status: 500 });
  }
});

