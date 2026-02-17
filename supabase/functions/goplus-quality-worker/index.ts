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

async function fetchGoPlusJson(url: string, apiKey: string | null): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const attempts: Array<() => Promise<Response>> = [];
  if (apiKey) {
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
    if (res.status === 401 || res.status === 403) continue;
    throw new Error(`GoPlus HTTP ${res.status}: ${lastText}`);
  }
  throw new Error(`GoPlus unauthorized: ${lastText}`);
}

function coerceBool(v: unknown): boolean | null {
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

function getObj(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function resultForKey(payload: unknown, key: string): Record<string, unknown> | null {
  const obj = getObj(payload);
  const r = obj["result"];
  if (r && typeof r === "object") {
    const m = r as Record<string, unknown>;
    const direct = m[key] ?? m[key.toLowerCase()];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  return null;
}

const MAX_JOBS_PER_INVOCATION = 30;

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
  const linkTtlHours = (() => {
    const v = Deno.env.get("GOPLUS_LINK_TTL_HOURS") ?? "24";
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 24;
  })();
  const rugTtlHours = (() => {
    const v = Deno.env.get("GOPLUS_RUGPULL_TTL_HOURS") ?? "24";
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 24;
  })();

  // Load mappings once (for rugpull_detecting chain_id)
  const mappingsRes = await supabase.from("chain_mappings").select("*");
  const mappings = new Map<string, MappingRow>();
  if (!mappingsRes.error) {
    for (const row of (mappingsRes.data ?? []) as MappingRow[]) mappings.set(row.dexscreener_chain_id, row);
  }

  const processed: Array<{ chain_id: string; token_address: string; ok: boolean; error?: string }> = [];
  let total = 0;

  while (total < MAX_JOBS_PER_INVOCATION) {
    const dq = await supabase.rpc("dequeue_token_quality_scans", { batch_size: 20 });
    if (dq.error) return json({ error: "dequeue failed", details: dq.error }, { status: 500 });
    const jobs = (dq.data ?? []) as Array<{ chain_id: string; token_address: string; attempts: number }>;
    if (jobs.length === 0) break;

    for (const job of jobs) {
      if (total >= MAX_JOBS_PER_INVOCATION) break;
      total++;

      const chainId = job.chain_id;
      const tokenAddress = job.token_address;
      try {
        // Lean mode: use denormalized tokens.website_url only (no raw profile/pair storage).
        const tr = await supabase
          .from("tokens")
          .select("website_url")
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress)
          .maybeSingle();
        const websiteUrl = (tr.data as any)?.website_url;
        const links = typeof websiteUrl === "string" && websiteUrl.trim() ? [websiteUrl.trim()] : [];

        // 1) URL checks (phishing_site + dapp_security) with cache
        for (const url of links) {
          const cached = await supabase
            .from("goplus_url_risk_cache")
            .select("url,scanned_at,is_phishing,dapp_risk_level")
            .eq("url", url)
            .maybeSingle();

          const scannedAt = cached.data?.scanned_at ? new Date(cached.data.scanned_at as string).getTime() : 0;
          const fresh = scannedAt && Date.now() - scannedAt < linkTtlHours * 60 * 60 * 1000;
          if (fresh) continue;

          // Docs:
          // - GET https://api.gopluslabs.io/api/v1/phishing_site
          // - GET https://api.gopluslabs.io/api/v1/dapp_security
          // Ref: https://docs.gopluslabs.io/reference/api-overview
          const phishingUrl = `https://api.gopluslabs.io/api/v1/phishing_site?url=${encodeURIComponent(url)}`;
          const dappUrl = `https://api.gopluslabs.io/api/v1/dapp_security?url=${encodeURIComponent(url)}`;

          const [phishingPayload, dappPayload] = await Promise.all([
            fetchGoPlusJson(phishingUrl, apiKey),
            fetchGoPlusJson(dappUrl, apiKey),
          ]);

          const pObj = getObj(phishingPayload);
          const dObj = getObj(dappPayload);

          // best-effort extraction (schema may vary)
          const pResult = pObj["result"];
          const isPhishing = coerceBool(
            (typeof pResult === "object" && pResult ? (pResult as any)["is_phishing"] ?? (pResult as any)["phishing"] : null) ??
              pObj["is_phishing"] ??
              pObj["phishing"],
          );
          const dResult = dObj["result"];
          const dappRisk =
            (typeof dResult === "object" && dResult ? (dResult as any)["risk_level"] ?? (dResult as any)["riskLevel"] : null) ??
            dObj["risk_level"] ??
            dObj["riskLevel"];
          const dappRiskLevel = typeof dappRisk === "string" ? dappRisk : dappRisk != null ? String(dappRisk) : null;

          await supabase.from("goplus_url_risk_cache").upsert(
            {
              url,
              raw_phishing: phishingPayload,
              raw_dapp: dappPayload,
              is_phishing: isPhishing,
              dapp_risk_level: dappRiskLevel,
              scanned_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "url" },
          );
        }

        // 2) Rug-pull detection (EVM only) with cache
        const mapping = mappings.get(chainId);
        if (mapping?.goplus_mode === "evm" && mapping.goplus_chain_id) {
          const cached = await supabase
            .from("goplus_rugpull_cache")
            .select("scanned_at")
            .eq("chain_id", chainId)
            .eq("token_address", tokenAddress)
            .maybeSingle();
          const scannedAt = cached.data?.scanned_at ? new Date(cached.data.scanned_at as string).getTime() : 0;
          const fresh = scannedAt && Date.now() - scannedAt < rugTtlHours * 60 * 60 * 1000;
          if (!fresh) {
            // Docs: GET https://api.gopluslabs.io/api/v1/rugpull_detecting/{chain_id}
            // Ref: https://docs.gopluslabs.io/reference/api-overview
            const url = `https://api.gopluslabs.io/api/v1/rugpull_detecting/${encodeURIComponent(mapping.goplus_chain_id)}?contract_addresses=${encodeURIComponent(
              tokenAddress,
            )}`;
            const payload = await fetchGoPlusJson(url, apiKey);
            const r = resultForKey(payload, tokenAddress) ?? getObj(payload);
            const isRisk = coerceBool((r as any)["is_rugpull"] ?? (r as any)["rugpull"] ?? (r as any)["is_rugpull_risk"]);
            const riskLevel = (r as any)["risk_level"] ?? (r as any)["riskLevel"];
            await supabase.from("goplus_rugpull_cache").upsert(
              {
                chain_id: chainId,
                token_address: tokenAddress,
                raw: payload,
                is_rugpull_risk: isRisk,
                risk_level: typeof riskLevel === "string" ? riskLevel : riskLevel != null ? String(riskLevel) : null,
                scanned_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "chain_id,token_address" },
            );
          }
        }

        await supabase
          .from("token_quality_scan_queue")
          .update({
            status: "completed",
            locked_at: null,
            updated_at: new Date().toISOString(),
            last_error: null,
            last_scanned_at: new Date().toISOString(),
            next_run_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress);

        processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const attempts = (job.attempts ?? 0) + 1;
        const backoffMs = Math.min(10 * 60 * 1000 * 2 ** Math.min(attempts, 6), 6 * 60 * 60 * 1000);
        await supabase
          .from("token_quality_scan_queue")
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
        processed.push({ chain_id: job.chain_id, token_address: job.token_address, ok: false, error: msg });
      }
    }
  }

  await supabase.from("edge_function_heartbeats").insert({
    function_name: "goplus-quality-worker",
    processed_count: processed.length,
    note: apiKey ? "api_key_set" : "api_key_missing",
  });

  return json({ ok: true, processed_count: processed.length, processed });
});

