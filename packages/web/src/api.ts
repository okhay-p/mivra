import type { AppType } from "@mivra/server";
import { hc } from "hono/client";

/** Typed client for the Mivra server API; types come from the server's route definitions. */
export const api = hc<AppType>(window.location.origin).api;
