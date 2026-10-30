import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";

/** Full error detail. Server-side only: stored in runs.error, never sent to a client. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The model request failed";
}

const STATUS_HINTS: Record<number, string> = {
  401: "the provider rejected the API key",
  402: "the provider account is out of credits",
  403: "the provider refused access to this model",
  404: "the provider doesn't know this model",
  429: "the provider is rate-limiting requests; try again shortly",
};

/**
 * An error message safe to show a client. Error text from providers can echo request content,
 * including private tool inputs such as a check's answer key, and an error's class doesn't
 * guarantee its message is safe. So clients only ever get server-owned messages, chosen by error
 * class and HTTP status; the original text stays server-side.
 */
export function publicErrorText(error: unknown): string {
  // Configuration problems the learner can fix.
  if (LoadAPIKeyError.isInstance(error)) {
    return "The model provider's API key is missing. Set it in .env (see .env.example) and restart the server.";
  }
  if (NoSuchModelError.isInstance(error)) return "Unknown model or provider. Check MIVRA_MODEL in .env.";
  if (APICallError.isInstance(error)) {
    const hint = error.statusCode ? STATUS_HINTS[error.statusCode] : undefined;
    return hint
      ? `The model request failed: ${hint}.`
      : `The model request failed${error.statusCode ? ` (HTTP ${error.statusCode})` : ""}.`;
  }
  return "The model request failed.";
}
