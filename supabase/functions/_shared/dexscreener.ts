export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry(
  url: string,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 4000;
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          // DexScreener sometimes returns 403 without a browser-like UA.
          "User-Agent": "DexSwipe/1.0 (+https://dexswipe.app)",
        },
        signal: controller.signal,
      });
      if (res.ok) return await res.json();

      const body = await res.text().catch(() => "");
      // retry on rate limit / transient server errors
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`HTTP ${res.status}: ${body}`);
      } else {
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }

    const wait = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await sleep(wait);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

