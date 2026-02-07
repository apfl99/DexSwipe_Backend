import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type MappingRow = {
  dexscreener_chain_id: string;
  goplus_mode: "evm" | "solana";
  goplus_chain_id: string | null;
};

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
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

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fetchGoPlusJson(
  url: string,
  apiKey: string | null,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };

  const attempts: Array<() => Promise<Response>> = [];
  if (apiKey) {
    // Auth header name is not visible in public docs without login.
    // Try common conventions in a safe order.
    attempts.push(() => fetch(url, { headers: { ...headers, Authorization: `Bearer ${apiKey}` } }));
    attempts.push(() => fetch(url, { headers: { ...headers, "X-API-KEY": apiKey } }));
    attempts.push(() => fetch(url, { headers: { ...headers, apikey: apiKey } }));
  } else {
    attempts.push(() => fetch(url, { headers }));
  }

  let lastText = "";
  for (const doFetch of attempts) {
    const res = await doFetch();
    if (res.ok) return await res.json();
    lastText = await res.text().catch(() => "");
    // If unauthorized, try the next header style
    if (res.status === 401 || res.status === 403) continue;
    throw new Error(`GoPlus HTTP ${res.status}: ${lastText}`);
  }

  throw new Error(`GoPlus unauthorized: ${lastText}`);
}

function extractResultForToken(payload: unknown, tokenAddress: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  const result = obj.result;
  if (result && typeof result === "object") {
    const lower = tokenAddress.toLowerCase();
    const r = result as Record<string, unknown>;
    const direct = r[lower] ?? r[tokenAddress] ?? r[tokenAddress.toLowerCase()];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  // Some endpoints may return the token object directly.
  return obj;
}

function computePolicy(fields: {
  cannot_sell: boolean | null;
  is_honeypot: boolean | null;
  sell_tax: number | null;
}): { always_deny: boolean; deny_reasons: string[] } {
  const reasons: string[] = [];
  if (fields.cannot_sell === true) reasons.push("cannot_sell");
  if (fields.is_honeypot === true) reasons.push("is_honeypot");
  // Conservative threshold: if sell tax > 50%, deny (tunable later)
  if (typeof fields.sell_tax === "number" && fields.sell_tax > 0.5) reasons.push("sell_tax_gt_50pct");
  return { always_deny: reasons.length > 0, deny_reasons: reasons };
}

const DEFAULT_BATCH = 20;
const MAX_JOBS_PER_INVOCATION = 50;

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

  const apiKey = Deno.env.get("GOPLUS_API_KEY") ?? null;

  const batchSize = (() => {
    const u = new URL(req.url);
    const s = u.searchParams.get("batch");
    const n = s ? Number.parseInt(s, 10) : DEFAULT_BATCH;
    return Number.isFinite(n) && n > 0 ? Math.min(n, DEFAULT_BATCH) : DEFAULT_BATCH;
  })();

  // Load mappings once
  const mappingsRes = await supabase.from("chain_mappings").select("*");
  if (mappingsRes.error) {
    return json({ error: "failed to read chain_mappings", details: mappingsRes.error }, { status: 500 });
  }
  const mappings = new Map<string, MappingRow>();
  for (const row of (mappingsRes.data ?? []) as MappingRow[]) {
    mappings.set(row.dexscreener_chain_id, row);
  }

  const processed: Array<{ chain_id: string; token_address: string; ok: boolean; error?: string; always_deny?: boolean }> = [];

  let total = 0;
  while (total < MAX_JOBS_PER_INVOCATION) {
    const dq = await supabase.rpc("dequeue_token_security_scans", { batch_size: batchSize });
    if (dq.error) {
      return json({ error: "dequeue failed", details: dq.error }, { status: 500 });
    }
    const jobs = (dq.data ?? []) as Array<{ chain_id: string; token_address: string; attempts: number }>;
    if (jobs.length === 0) break;

    for (const job of jobs) {
      if (total >= MAX_JOBS_PER_INVOCATION) break;
      total++;

      const chainId = job.chain_id;
      const tokenAddress = job.token_address;

      try {
        const mapping = mappings.get(chainId);
        if (!mapping) {
          throw new Error(`UNSUPPORTED_CHAIN: ${chainId} (missing chain_mappings row)`);
        }

        let url: string;
        if (mapping.goplus_mode === "solana") {
          // GoPlus provides a dedicated Solana endpoint (beta)
          url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(tokenAddress)}`;
        } else {
          const goplusChainId = mapping.goplus_chain_id;
          if (!goplusChainId) throw new Error(`missing goplus_chain_id for chain ${chainId}`);
          url =
            `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(goplusChainId)}?contract_addresses=${
              encodeURIComponent(tokenAddress)
            }`;
        }

        const payload = await fetchGoPlusJson(url, apiKey);
        const result = extractResultForToken(payload, tokenAddress) ?? {};

        // Extract common fields (best-effort)
        const cannot_sell = flag(result["cannot_sell"] ?? result["cannotSell"]);
        const is_honeypot = flag(result["is_honeypot"] ?? result["isHoneypot"]);
        const is_proxy = flag(result["is_proxy"] ?? result["isProxy"]);
        const contract_upgradeable = flag(result["contract_upgradeable"] ?? result["contractUpgradeable"]);
        const buy_tax = num(result["buy_tax"] ?? result["buyTax"]);
        const sell_tax = num(result["sell_tax"] ?? result["sellTax"]);

        const policy = computePolicy({ cannot_sell, is_honeypot, sell_tax });

        const up = await supabase
          .from("goplus_token_security_cache")
          .upsert(
            {
              chain_id: chainId,
              token_address: tokenAddress,
              raw: payload,
              scanned_at: new Date().toISOString(),
              cannot_sell,
              is_honeypot,
              is_proxy,
              contract_upgradeable,
              buy_tax,
              sell_tax,
              always_deny: policy.always_deny,
              deny_reasons: policy.deny_reasons,
            },
            { onConflict: "chain_id,token_address" },
          );
        if (up.error) throw new Error(`cache upsert failed: ${up.error.message}`);

        const q = await supabase
          .from("token_security_scan_queue")
          .update({
            status: "completed",
            attempts: job.attempts,
            locked_at: null,
            updated_at: new Date().toISOString(),
            last_error: null,
            last_scanned_at: new Date().toISOString(),
            // re-scan policy can be tuned later; default 6h
            next_run_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          })
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress);
        if (q.error) throw new Error(`queue update failed: ${q.error.message}`);

        processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true, always_deny: policy.always_deny });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isUnsupported = msg.startsWith("UNSUPPORTED_CHAIN:");
        if (isUnsupported) {
          // Do not retry unsupported chains endlessly.
          await supabase
            .from("token_security_scan_queue")
            .update({
              status: "completed",
              locked_at: null,
              updated_at: new Date().toISOString(),
              last_error: msg,
              next_run_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .eq("chain_id", job.chain_id)
            .eq("token_address", job.token_address);
        } else {
          const attempts = (job.attempts ?? 0) + 1;
          const backoffMs = Math.min(5 * 60 * 1000 * 2 ** Math.min(attempts, 6), 60 * 60 * 1000);
          await supabase
            .from("token_security_scan_queue")
            .update({
              status: "failed",
              attempts,
              locked_at: null,
              updated_at: new Date().toISOString(),
              last_error: msg,
              next_run_at: new Date(Date.now() + backoffMs).toISOString(),
            })
            .eq("chain_id", job.chain_id)
            .eq("token_address", job.token_address);
        }
        processed.push({ chain_id: job.chain_id, token_address: job.token_address, ok: false, error: msg });
      }
    }
  }

  return json({
    ok: true,
    processed_count: processed.length,
    processed,
    note: apiKey ? "GOPLUS_API_KEY set" : "GOPLUS_API_KEY not set (may fail if GoPlus requires auth)",
  });
});

