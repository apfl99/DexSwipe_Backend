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

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);
  const offset = Math.max(Number.parseInt(u.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const chains = parseChains(u.searchParams.get("chains"));

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // 1) Base list from latest profiles
  let q = supabase
    .from("dexscreener_token_profiles_raw")
    .select("chain_id,token_address,raw,fetched_at")
    .order("fetched_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (chains) {
    q = q.in("chain_id", chains);
  }

  const profilesRes = await q;
  if (profilesRes.error) return json({ error: profilesRes.error.message }, { status: 500 });

  const profiles = (profilesRes.data ?? []) as Array<{
    chain_id: string;
    token_address: string;
    raw: unknown;
    fetched_at: string;
  }>;

  if (profiles.length === 0) {
    return json({ tokens: [], next_offset: offset, limit });
  }

  // 2) Batch load boosts/takeovers/security for these tokens (best-effort, per-chain).
  const byChain = new Map<string, string[]>();
  for (const p of profiles) {
    const arr = byChain.get(p.chain_id) ?? [];
    arr.push(p.token_address);
    byChain.set(p.chain_id, arr);
  }

  const boosts = new Map<string, unknown>();
  const takeovers = new Map<string, unknown>();
  const security = new Map<string, { always_deny: boolean; deny_reasons: string[]; scanned_at: string | null }>();

  for (const [chain, addrs] of byChain.entries()) {
    const addrFilter = `{${addrs.map((a) => JSON.stringify(a)).join(",")}}`;

    const b = await supabase
      .from("dexscreener_token_boosts_raw")
      .select("chain_id,token_address,raw,amount,total_amount")
      .eq("chain_id", chain)
      .filter("token_address", "in", addrFilter);
    if (!b.error) {
      for (const r of (b.data ?? []) as Array<{ chain_id: string; token_address: string; raw: unknown }>) {
        boosts.set(`${r.chain_id}:${r.token_address}`, r.raw);
      }
    }

    const t = await supabase
      .from("dexscreener_community_takeovers_raw")
      .select("chain_id,token_address,raw,claim_date")
      .eq("chain_id", chain)
      .filter("token_address", "in", addrFilter);
    if (!t.error) {
      for (const r of (t.data ?? []) as Array<{ chain_id: string; token_address: string; raw: unknown }>) {
        takeovers.set(`${r.chain_id}:${r.token_address}`, r.raw);
      }
    }

    const s = await supabase
      .from("goplus_token_security_cache")
      .select("chain_id,token_address,always_deny,deny_reasons,scanned_at")
      .eq("chain_id", chain)
      .filter("token_address", "in", addrFilter);
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
  }

  // 3) Compose items and exclude always_deny
  const items: FeedItem[] = [];
  for (const p of profiles) {
    const key = `${p.chain_id}:${p.token_address}`;
    const sec = security.get(key) ?? null;
    if (sec?.always_deny) continue;
    items.push({
      chain_id: p.chain_id,
      token_address: p.token_address,
      fetched_at: p.fetched_at,
      profile: p.raw,
      boost: boosts.get(key) ?? null,
      takeover: takeovers.get(key) ?? null,
      security: sec,
    });
  }

  return json({
    tokens: items,
    limit,
    next_offset: offset + limit,
    notes: {
      pagination: "offset/limit (can be upgraded to keyset cursor later)",
      security_filter: "always_deny tokens are excluded",
    },
  });
});

