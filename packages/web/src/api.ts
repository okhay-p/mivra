import type { AppType } from "@mivra/server";
import { hc } from "hono/client";

/** API token the server (or Vite in dev) embeds in index.html. */
export const token = document.querySelector<HTMLMetaElement>('meta[name="mivra-token"]')?.content ?? "";

export const authHeaders = { Authorization: `Bearer ${token}` };

/** Typed client for the Mivra server API; types come from the server's route definitions. */
export const api = hc<AppType>(window.location.origin, { headers: authHeaders }).api;

/** Reads the server's `{ error }` body, falling back to the status text. */
export async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return `${res.status} ${res.statusText}`;
}
