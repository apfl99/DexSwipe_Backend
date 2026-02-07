import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type DexScreenerProfile = Record<string, unknown> & {
  chainId?: string;
  tokenAddress?: string;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

const DEXSCREENER_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const UPSERT_CHUNK_SIZE = 250;

Deno.serve(async (req) => {
  // Simple shared-secret auth for cron/webhook style calls.
  // If DEXSWIPE_CRON_SECRET is unset, auth is effectively disabled (dev convenience).
  const expectedSecret = Deno.env.get("DEXSWIPE_CRON_SECRET") ?? "";
  if (expectedSecret) {
    const providedSecret = req.headers.get("x-cron-secret") ?? "";
    if (providedSecret !== expectedSecret) {
      return jsonResponse({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Only enqueue security scans for chains we can scan (configured in chain_mappings).
  const supportedChainsRes = await supabase.from("chain_mappings").select("dexscreener_chain_id");
  if (supportedChainsRes.error) {
    return jsonResponse(
      { error: "failed to read chain_mappings", details: supportedChainsRes.error },
      { status: 500 },
    );
  }
  const supportedChains = new Set(
    (supportedChainsRes.data ?? []).map((r: { dexscreener_chain_id: string }) => r.dexscreener_chain_id),
  );

  const startedAt = new Date();

  const runInsert = await supabase
    .from("dexscreener_ingestion_runs")
    .insert({
      status: "running",
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  const runId = runInsert.data?.id as string | undefined;
  if (runInsert.error || !runId) {
    return jsonResponse(
      { error: "failed to create run row", details: runInsert.error },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(DEXSCREENER_URL, {
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `DexScreener error: HTTP ${res.status} ${res.statusText} ${text}`,
      );
    }

    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error("DexScreener response is not an array");
    }

    const profiles = json as DexScreenerProfile[];
    const rows = profiles
      .map((p) => ({
        chain_id: p.chainId ?? null,
        token_address: p.tokenAddress ?? null,
        raw: p,
        fetched_at: startedAt.toISOString(),
        updated_at: startedAt.toISOString(),
        last_run_id: runId,
      }))
      .filter((r) => typeof r.chain_id === "string" && typeof r.token_address === "string");

    let upserted = 0;
    for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
      const up = await supabase
        .from("dexscreener_token_profiles_raw")
        .upsert(batch, { onConflict: "chain_id,token_address" });
      if (up.error) throw new Error(`upsert failed: ${up.error.message}`);
      upserted += batch.length;
    }

    // Enqueue security scan jobs (deduped by PK on queue table).
    // This is the "Distribution" step in the assembly-line pattern.
    const toEnqueue = new Map<string, { chain_id: string; token_address: string }>();
    for (const r of rows) {
      const chainId = r.chain_id as string;
      if (!supportedChains.has(chainId)) continue;
      toEnqueue.set(`${chainId}:${r.token_address}`, {
        chain_id: chainId,
        token_address: r.token_address as string,
      });
    }
    const enqueueRows = [...toEnqueue.values()];
    if (enqueueRows.length) {
      const enq = await supabase
        .from("token_security_scan_queue")
        .upsert(enqueueRows, { onConflict: "chain_id,token_address", ignoreDuplicates: true });
      if (enq.error) throw new Error(`enqueue failed: ${enq.error.message}`);
    }

    await supabase
      .from("dexscreener_ingestion_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        fetched_count: profiles.length,
        upserted_count: upserted,
      })
      .eq("id", runId);

    return jsonResponse({
      ok: true,
      fetched: profiles.length,
      stored: upserted,
      enqueued_security_scans: enqueueRows.length,
      run_id: runId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("dexscreener_ingestion_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: msg,
      })
      .eq("id", runId);

    return jsonResponse({ ok: false, error: msg, run_id: runId }, { status: 500 });
  }
});

