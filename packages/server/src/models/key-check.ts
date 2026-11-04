import type { ProviderId } from "../credentials.js";

export type KeyCheck = { ok: true } | { ok: false; reason: "rejected" | "unreachable"; message: string };

const TIMEOUT_MS = 10_000;

/** One authenticated request that costs nothing: each provider's key or model-list endpoint. */
function probe(provider: ProviderId, key: string, baseUrl: string | undefined): { url: string; headers: Record<string, string> } {
  const base = (fallback: string) => (baseUrl ?? fallback).replace(/\/$/, "");
  switch (provider) {
    case "openrouter":
      return { url: "https://openrouter.ai/api/v1/key", headers: { authorization: `Bearer ${key}` } };
    case "anthropic":
      return { url: `${base("https://api.anthropic.com/v1")}/models?limit=1`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
    case "openai":
      return { url: `${base("https://api.openai.com/v1")}/models`, headers: { authorization: `Bearer ${key}` } };
  }
}

/** Checks that the provider accepts a key, without spending tokens (ADR-013). */
export async function checkProviderKey(
  provider: ProviderId,
  key: string,
  { fetch: fetchImpl = fetch, baseUrl }: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<KeyCheck> {
  const { url, headers } = probe(provider, key, baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: "unreachable", message: "Couldn't reach the provider. Check your connection and try again." };
  }
  // The body isn't needed; release the connection.
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "rejected", message: "The provider rejected this key." };
  return { ok: false, reason: "unreachable", message: `The provider answered ${response.status}. Try again later.` };
}
