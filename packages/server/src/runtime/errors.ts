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
 * An error message safe to show a client. Arbitrary error text can echo request content, including
 * private tool inputs such as a check's answer key, so only errors whose messages are known to be
 * about configuration are passed through; everything else is generic.
 */
export function publicErrorText(error: unknown): string {
  // Configuration problems the learner can fix: missing key, unknown provider or model.
  if (LoadAPIKeyError.isInstance(error) || NoSuchModelError.isInstance(error)) return error.message;
  if (APICallError.isInstance(error)) {
    const hint = error.statusCode ? STATUS_HINTS[error.statusCode] : undefined;
    return hint
      ? `The model request failed: ${hint}.`
      : `The model request failed${error.statusCode ? ` (HTTP ${error.statusCode})` : ""}.`;
  }
  return "The model request failed.";
}
