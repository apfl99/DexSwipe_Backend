import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchJsonWithRetry } from "../_shared/dexscreener.ts";

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init,
  });
}

function getClientId(req: Request): string {
  return req.headers.get("x-client-id")?.trim() ?? "";
}

type WishlistRow = {
  user_device_id: string;
  token_id: string;
  created_at: string;
  captured_price?: number | null;
  captured_at?: string | null;
};

type Pair = Record<string, unknown> & {
  chainId?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseTokenId(tokenId: string): { chainId: string; tokenAddress: string } | null {
  const i = tokenId.indexOf(":");
  if (i <= 0) return null;
  const chainId = tokenId.slice(0, i).trim();
  const tokenAddress = tokenId.slice(i + 1).trim();
  if (!chainId || !tokenAddress) return null;
  return { chainId, tokenAddress };
}

function bestPriceUsd(pairs: unknown[], chainId: string, tokenAddress: string): number | null {
  const rows = Array.isArray(pairs) ? (pairs as Pair[]) : [];
  let best: { liq: number; price: number } | null = null;
  for (const p of rows) {
    if (!p || typeof p !== "object") continue;
    if (p.chainId !== chainId) continue;
    const addr = p.baseToken?.address;
    if (typeof addr !== "string") continue;
    if (addr.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    const price = num(p.priceUsd);
    if (price === null) continue;
    const liq = num((p.liquidity as any)?.usd) ?? 0;
    if (!best || liq > best.liq) best = { liq, price };
  }
  return best ? best.price : null;
}

Deno.serve(async (req) => {
  const clientId = getClientId(req);
  if (!clientId) return json({ error: "missing required header: x-client-id" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const u = new URL(req.url);

  // GET: list wishlist
  if (req.method === "GET") {
    const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get("limit") ?? "100", 10) || 100, 1), 200);
    const res = await supabase
      .from("wishlist")
      .select("user_device_id,token_id,created_at,captured_price,captured_at")
      .eq("user_device_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (res.error) return json({ error: res.error.message }, { status: 500 });
    const rows = (res.data ?? []) as WishlistRow[];
    return json({
      items: rows.map((r) => ({
        token_id: r.token_id,
        created_at: r.created_at,
        captured_price: r.captured_price ?? null,
        captured_at: r.captured_at ?? null,
      })),
      limit,
    });
  }

  // POST: add { token_id }
  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const tokenId = typeof body?.token_id === "string" ? body.token_id.trim() : "";
    if (!tokenId) return json({ error: "missing body.token_id" }, { status: 400 });

    const now = new Date().toISOString();
    const parsed = parseTokenId(tokenId);
    let capturedPrice: number | null = null;

    // Prefer current snapshot in tokens table.
    if (parsed) {
      const tr = await supabase
        .from("tokens")
        .select("price_usd")
        .eq("chain_id", parsed.chainId)
        .eq("token_address", parsed.tokenAddress)
        .maybeSingle();
      if (!tr.error) capturedPrice = (tr.data as any)?.price_usd ?? null;
    }

    // Fallback: fetch from DexScreener once (on-demand).
    if (capturedPrice === null && parsed) {
      const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(parsed.chainId)}/${encodeURIComponent(
        parsed.tokenAddress,
      )}`;
      const payload = await fetchJsonWithRetry(url, { maxAttempts: 3, timeoutMs: 15_000 });
      // response is array of pairs
      capturedPrice = bestPriceUsd(payload as any, parsed.chainId, parsed.tokenAddress);
    }

    const up = await supabase.from("wishlist").upsert(
      {
        user_device_id: clientId,
        token_id: tokenId,
        created_at: now,
        captured_price: capturedPrice,
        captured_at: now,
      },
      { onConflict: "user_device_id,token_id" },
    );
    if (up.error) return json({ error: up.error.message }, { status: 500 });
    return json({ ok: true, token_id: tokenId, created_at: now, captured_price: capturedPrice, captured_at: now });
  }

  // DELETE: /wishlist?token_id=...
  if (req.method === "DELETE") {
    const tokenId = (u.searchParams.get("token_id") ?? "").trim();
    if (!tokenId) return json({ error: "missing query token_id" }, { status: 400 });
    const del = await supabase.from("wishlist").delete().eq("user_device_id", clientId).eq("token_id", tokenId);
    if (del.error) return json({ error: del.error.message }, { status: 500 });
    return json({ ok: true, token_id: tokenId });
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
});

