/// <reference path="./tsserver_shims.d.ts" />

type SupabaseLike = {
  from: (table: string) => any;
};

export type GoPlusAuthSource = "access_token_env" | "db_cache" | "refreshed" | "legacy_api_key" | "none";

function hexFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return hexFromBytes(new Uint8Array(digest));
}

async function postJson(url: string, body: unknown, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export async function getGoPlusAccessToken(supabase: SupabaseLike): Promise<{ token: string | null; source: GoPlusAuthSource; note?: string }> {
  // 1) Explicit access token override (no rotation handled here)
  const envAccessToken = (Deno.env.get("GOPLUS_ACCESS_TOKEN") ?? "").trim();
  if (envAccessToken) return { token: envAccessToken, source: "access_token_env" };

  // 2) AppKey/AppSecret -> issue/refresh access token and cache in DB
  const appKey = (Deno.env.get("GOPLUS_APP_KEY") ?? "").trim();
  const appSecret = (Deno.env.get("GOPLUS_APP_SECRET") ?? "").trim();
  if (appKey && appSecret) {
    const cached = await supabase
      .from("goplus_access_token_cache")
      .select("access_token,expires_at")
      .eq("id", 1)
      .maybeSingle();

    const expiresAtMs =
      cached?.data?.expires_at ? new Date(String(cached.data.expires_at)).getTime() : Number.NaN;
    const stillValid = Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > 5 * 60 * 1000;
    const cachedToken = typeof cached?.data?.access_token === "string" ? cached.data.access_token.trim() : "";
    if (!cached?.error && stillValid && cachedToken) {
      return { token: cachedToken, source: "db_cache" };
    }

    const time = Math.floor(Date.now() / 1000);
    const sign = await sha1Hex(`${appKey}${time}${appSecret}`);
    const payload = await postJson("https://api.gopluslabs.io/api/v1/token", { app_key: appKey, sign, time }, 12_000);
    const env: any = payload && typeof payload === "object" ? payload : null;
    const codeRaw = env?.code ?? env?.Code ?? null;
    const code = typeof codeRaw === "number" ? codeRaw : typeof codeRaw === "string" ? Number.parseInt(codeRaw, 10) : NaN;
    const message = typeof env?.message === "string" ? env.message : null;
    if (code !== 1) {
      return { token: null, source: "none", note: `access_token_issue_failed: code=${Number.isFinite(code) ? code : "unknown"}${message ? ` msg=${message}` : ""}` };
    }
    const token = typeof env?.result?.access_token === "string" ? env.result.access_token.trim() : "";
    const expiresIn = typeof env?.result?.expires_in === "number" ? env.result.expires_in : Number.NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 60 ? new Date(Date.now() + expiresIn * 1000) : new Date(Date.now() + 6 * 60 * 60 * 1000);

    if (!token) return { token: null, source: "none", note: "access_token_missing_in_response" };

    await supabase
      .from("goplus_access_token_cache")
      .upsert(
        { id: 1, access_token: token, expires_at: expiresAt.toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );

    return { token, source: "refreshed" };
  }

  // 3) Legacy: GOPLUS_API_KEY treated as access token.
  const legacy = (Deno.env.get("GOPLUS_API_KEY") ?? "").trim();
  if (legacy) return { token: legacy, source: "legacy_api_key" };

  return { token: null, source: "none" };
}

