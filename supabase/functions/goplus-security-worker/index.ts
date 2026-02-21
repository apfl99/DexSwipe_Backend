import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getPlanConfig } from "../_shared/plan.ts";
import { getGoPlusAccessToken } from "../_shared/goplus_auth.ts";

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
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      lastText = text;
      // If unauthorized, try the next header style
      if (res.status === 401 || res.status === 403) continue;
      throw new Error(`GoPlus HTTP ${res.status}: ${lastText}`);
    }

    // GoPlus can return HTTP 200 even when auth fails (e.g., code=4012).
    // In that case, try the next header style.
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`GoPlus non-JSON 200: ${text}`);
    }
    const codeRaw = json?.code ?? json?.Code ?? null;
    const code = typeof codeRaw === "number" ? codeRaw : typeof codeRaw === "string" ? Number.parseInt(codeRaw, 10) : NaN;
    const msg = typeof json?.message === "string" ? json.message : "";
    if (code === 1) return json;
    lastText = text;
    if (code === 4012 || msg.toLowerCase().includes("signature verification failure")) continue;
    return json;
  }

  throw new Error(`GoPlus unauthorized: ${lastText}`);
}

function extractResultForToken(payload: unknown, tokenAddress: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;
  const result = obj.result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    // Solana addresses are case-sensitive. Try exact key first, then fall back.
    const direct = r[tokenAddress] ?? r[tokenAddress.toLowerCase()] ?? r[tokenAddress.toUpperCase()];
    if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  }
  // Some endpoints may return the token object directly.
  return obj;
}

function computePolicy(fields: {
  cannot_sell: boolean | null;
  is_honeypot: boolean | null;
  sell_tax: number | null;
  is_blacklisted: boolean | null;
  cannot_sell_all: boolean | null;
  buy_tax: number | null;
}): { always_deny: boolean; deny_reasons: string[] } {
  const reasons: string[] = [];
  if (fields.cannot_sell === true) reasons.push("cannot_sell");
  if (fields.cannot_sell_all === true) reasons.push("cannot_sell_all");
  if (fields.is_honeypot === true) reasons.push("is_honeypot");
  if (fields.is_blacklisted === true) reasons.push("is_blacklisted");
  // Conservative threshold: if sell tax > 50%, deny (tunable later)
  if (typeof fields.sell_tax === "number" && fields.sell_tax > 0.5) reasons.push("sell_tax_gt_50pct");
  if (typeof fields.buy_tax === "number" && fields.buy_tax > 0.5) reasons.push("buy_tax_gt_50pct");
  return { always_deny: reasons.length > 0, deny_reasons: reasons };
}

const DEFAULT_BATCH = 20;
const MAX_JOBS_PER_INVOCATION = 50;

function estimateCu(chainId: string): number {
  // Based on your GoPlus dashboard:
  // - Solana Token Security: 30 CU / token
  // - EVM Token Security: 15 CU / token
  // (We treat unknown as EVM-cost for safety.)
  if (chainId === "solana") return 30;
  return 15;
}

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

  const auth = await getGoPlusAccessToken(supabase);
  const apiKey = auth.token;
  const plan = getPlanConfig();
  const cuBudget = plan.goplus_cu_budget_per_run;
  let cuUsed = 0;
  const cacheTtlHours = plan.goplus_cache_ttl_hours;
  const dailyMaxScans = plan.goplus_daily_max_scans;
  const utcDayStart = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  })();
  const utcTomorrowStart = (() => {
    const d = new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1000);
    return d;
  })();

  // FREE daily scan cap guardrail (counts total security scans today; with FREE TTL=24h this ~= 신규 스캔 상한)
  let scansToday = 0;
  if (dailyMaxScans !== null) {
    const c = await supabase
      .from("goplus_token_security_cache")
      .select("scanned_at", { count: "exact", head: true })
      .gte("scanned_at", utcDayStart.toISOString());
    scansToday = !c.error ? c.count ?? 0 : 0;
  }

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

    for (let idx = 0; idx < jobs.length; idx++) {
      const job = jobs[idx];
      if (total >= MAX_JOBS_PER_INVOCATION) break;
      const jobCu = estimateCu(job.chain_id);
      total++;

      const chainId = job.chain_id;
      const tokenAddress = job.token_address;

      try {
        // Cache-first: if we have a fresh cache row, avoid consuming GoPlus CU.
        const cached = await supabase
          .from("goplus_token_security_cache")
          .select("scanned_at,always_deny,deny_reasons")
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress)
          .maybeSingle();
        if (!cached.error && cached.data?.scanned_at) {
          // Scam permanence: if always_deny is true, never spend CU again on this token.
          if ((cached.data as any)?.always_deny === true) {
            await supabase
              .from("token_security_scan_queue")
              .update({
                status: "completed",
                attempts: job.attempts,
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: null,
                last_scanned_at: new Date().toISOString(),
                next_run_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
              })
              .eq("chain_id", chainId)
              .eq("token_address", tokenAddress);
            processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true, always_deny: true });
            continue;
          }

          const scannedAtMs = new Date(cached.data.scanned_at as string).getTime();
          if (Number.isFinite(scannedAtMs) && Date.now() - scannedAtMs < cacheTtlHours * 60 * 60 * 1000) {
            await supabase
              .from("token_security_scan_queue")
              .update({
                status: "completed",
                attempts: job.attempts,
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: null,
                last_scanned_at: new Date().toISOString(),
                next_run_at: new Date(Date.now() + cacheTtlHours * 60 * 60 * 1000).toISOString(),
              })
              .eq("chain_id", chainId)
              .eq("token_address", tokenAddress);
            processed.push({
              chain_id: chainId,
              token_address: tokenAddress,
              ok: true,
              always_deny: (cached.data as any)?.always_deny ?? false,
            });
            continue;
          }
        }

        // Daily scan cap (FREE): defer remaining jobs to tomorrow (no CU waste).
        if (dailyMaxScans !== null && scansToday >= dailyMaxScans) {
          await supabase
            .from("token_security_scan_queue")
            .update({
              status: "completed",
              locked_at: null,
              updated_at: new Date().toISOString(),
              last_error: "daily_scan_cap_free",
              next_run_at: new Date(utcTomorrowStart.getTime() + 5 * 60 * 1000).toISOString(),
            })
            .eq("chain_id", chainId)
            .eq("token_address", tokenAddress);
          processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true });
          continue;
        }

        // Dead Token Drop: if there's no meaningful market activity for 24h, do not rescan forever.
        // (Best-effort approximation: updated_at older than 24h and volume_24h is 0/null.)
        const market = await supabase
          .from("tokens")
          .select("volume_24h,updated_at")
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress)
          .maybeSingle();
        if (!market.error && market.data?.updated_at) {
          const updatedAtMs = new Date((market.data as any).updated_at as string).getTime();
          const vol = (market.data as any).volume_24h;
          const volNum = typeof vol === "number" ? vol : typeof vol === "string" ? Number.parseFloat(vol) : NaN;
          const isDead = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= 24 * 60 * 60 * 1000 && (!Number.isFinite(volNum) || volNum <= 0);
          if (isDead) {
            await supabase
              .from("token_security_scan_queue")
              .update({
                status: "completed",
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: "dead_token_drop",
                next_run_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
              })
              .eq("chain_id", chainId)
              .eq("token_address", tokenAddress);
            processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true });
            continue;
          }
        }

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

        // CU budget guardrail: if we cannot afford this job, defer this and all remaining dequeued jobs.
        if (cuUsed + jobCu > cuBudget) {
          const nextRunAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          for (let j = idx; j < jobs.length; j++) {
            const x = jobs[j];
            await supabase
              .from("token_security_scan_queue")
              .update({
                status: "completed",
                locked_at: null,
                updated_at: new Date().toISOString(),
                last_error: "cu_budget_exhausted",
                next_run_at: nextRunAt,
              })
              .eq("chain_id", x.chain_id)
              .eq("token_address", x.token_address);
            processed.push({ chain_id: x.chain_id, token_address: x.token_address, ok: true });
          }
          break;
        }
        cuUsed += jobCu;

        const payload = await fetchGoPlusJson(url, apiKey);
        const envelope: any = payload && typeof payload === "object" ? payload : null;
        const codeRaw = envelope?.code ?? envelope?.Code ?? null;
        const code = typeof codeRaw === "number" ? codeRaw : typeof codeRaw === "string" ? Number.parseInt(codeRaw, 10) : NaN;
        const message = typeof envelope?.message === "string" ? envelope.message : "";
        if (code !== 1) {
          if (code === 7012 || code === 7013) {
            throw new Error(`UNSUPPORTED_TOKEN: GOPLUS_CODE_${Number.isFinite(code) ? code : "unknown"}: ${message}`);
          }
          throw new Error(`GOPLUS_CODE_${Number.isFinite(code) ? code : "unknown"}: ${message}`);
        }
        const result = extractResultForToken(payload, tokenAddress) ?? {};

        // Extract common fields (best-effort)
        const cannot_sell = flag(result["cannot_sell"] ?? result["cannotSell"]);
        const is_honeypot = flag(result["is_honeypot"] ?? result["isHoneypot"]);
        const is_proxy = flag(result["is_proxy"] ?? result["isProxy"]);
        const contract_upgradeable = flag(result["contract_upgradeable"] ?? result["contractUpgradeable"]);
        const buy_tax = num(result["buy_tax"] ?? result["buyTax"]);
        const sell_tax = num(result["sell_tax"] ?? result["sellTax"]);
        const cannot_sell_all = flag(
          result["cannot_sell_all"] ?? result["cannotSellAll"] ?? result["cannot_sell"] ?? result["cannotSell"],
        );
        const trust_list = flag(
          result["trust_list"] ??
            result["trustList"] ??
            result["is_in_trust_list"] ??
            result["isInTrustList"] ??
            result["in_trust_list"] ??
            result["inTrustList"],
        );
        const is_blacklisted = flag(
          result["is_blacklisted"] ?? result["isBlacklisted"] ?? result["blacklisted"] ?? result["is_in_blacklist"],
        );

        const transfer_pausable = flag(
          result["transfer_pausable"] ?? result["transferPausable"] ?? result["can_pause_transfer"] ??
            result["canPauseTransfer"],
        );
        const slippage_modifiable = flag(
          result["slippage_modifiable"] ?? result["slippageModifiable"] ?? result["is_slippage_modifiable"],
        );
        const external_call = flag(result["external_call"] ?? result["externalCall"]);
        const owner_change_balance = flag(
          result["owner_change_balance"] ?? result["ownerChangeBalance"] ?? result["owner_change_balance_ability"],
        );
        const hidden_owner = flag(result["hidden_owner"] ?? result["hiddenOwner"]);
        const cannot_buy = flag(result["cannot_buy"] ?? result["cannotBuy"]);
        const trading_cooldown = flag(result["trading_cooldown"] ?? result["tradingCooldown"]);
        const is_open_source = flag(result["is_open_source"] ?? result["isOpenSource"]);
        const is_mintable = flag(result["is_mintable"] ?? result["isMintable"] ?? result["mintable"]);
        const take_back_ownership = flag(
          result["take_back_ownership"] ?? result["takeBackOwnership"] ?? result["can_take_back_ownership"],
        );

        // Solana token_security fields are objects with {status:"0"|"1"}.
        const solStatus = (k: string) => flag((result as any)?.[k]?.status);
        const solMintable = solStatus("mintable");
        const solFreezable = solStatus("freezable");
        const solMetadataMutable = solStatus("metadata_mutable");
        const solNonTransferable = solStatus("non_transferable");

        const policy = computePolicy({
          cannot_sell,
          is_honeypot,
          sell_tax,
          is_blacklisted,
          cannot_sell_all: cannot_sell_all ?? solNonTransferable,
          buy_tax,
        });

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
              trust_list,
              is_blacklisted,
              cannot_sell_all: cannot_sell_all ?? solNonTransferable,
              transfer_pausable: transfer_pausable ?? solFreezable,
              slippage_modifiable,
              external_call,
              owner_change_balance,
              hidden_owner,
              cannot_buy,
              trading_cooldown,
              is_open_source,
              is_mintable: is_mintable ?? solMintable,
              take_back_ownership: take_back_ownership ?? solMetadataMutable,
              always_deny: policy.always_deny,
              deny_reasons: policy.deny_reasons,
            },
            { onConflict: "chain_id,token_address" },
          );
        if (up.error) throw new Error(`cache upsert failed: ${up.error.message}`);

        // If we actually called GoPlus, increment today's scan counter (for FREE cap).
        if (dailyMaxScans !== null) scansToday++;

        const q = await supabase
          .from("token_security_scan_queue")
          .update({
            status: "completed",
            attempts: job.attempts,
            locked_at: null,
            updated_at: new Date().toISOString(),
            last_error: null,
            last_scanned_at: new Date().toISOString(),
            // Scam permanence: never rescan always_deny tokens.
            next_run_at: policy.always_deny
              ? new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString()
              : new Date(Date.now() + cacheTtlHours * 60 * 60 * 1000).toISOString(),
          })
          .eq("chain_id", chainId)
          .eq("token_address", tokenAddress);
        if (q.error) throw new Error(`queue update failed: ${q.error.message}`);

        processed.push({ chain_id: chainId, token_address: tokenAddress, ok: true, always_deny: policy.always_deny });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isUnsupported = msg.startsWith("UNSUPPORTED_CHAIN:");
        const isUnsupportedToken = msg.startsWith("UNSUPPORTED_TOKEN:");
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
        } else if (isUnsupportedToken) {
          // Do not retry invalid token addresses endlessly.
          await supabase
            .from("token_security_scan_queue")
            .update({
              status: "completed",
              locked_at: null,
              updated_at: new Date().toISOString(),
              last_error: msg,
              next_run_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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
    if (cuUsed >= cuBudget) break;
  }

  // Heartbeat row: proves the worker ran (cron vs manual).
  // Stored in DB for easy verification from anywhere.
  await supabase.from("edge_function_heartbeats").insert({
    function_name: "goplus-security-worker",
    processed_count: processed.length,
    note: `${apiKey ? "api_key_set" : "api_key_missing"};auth=${auth.source}${auth.note ? `(${auth.note})` : ""};tier=${plan.tier};cu=${cuUsed}/${cuBudget};scansToday=${scansToday}${dailyMaxScans !== null ? `/${dailyMaxScans}` : ""}`,
  });

  return json({
    ok: true,
    processed_count: processed.length,
    processed,
    cu_used: cuUsed,
    cu_budget: cuBudget,
    note: apiKey ? "GOPLUS_API_KEY set" : "GOPLUS_API_KEY not set (may fail if GoPlus requires auth)",
  });
});


