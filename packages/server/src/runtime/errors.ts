import { APICallError, LoadAPIKeyError, NoSuchModelError, RetryError } from "ai";
import { CHATGPT_USAGE_LIMIT_ERROR } from "@mivra/protocol";
import { ChatGptError, errorCode } from "../chatgpt/oauth.js";

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

const SIGN_IN_AGAIN = "ChatGPT didn't accept Mivra's sign-in. Sign in again under Model providers.";

/** Errors from the ChatGPT route (ADR-015), by OpenAI's error code. The messages are Mivra's own. */
const CHATGPT_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: CHATGPT_USAGE_LIMIT_ERROR,
  subscription_sharing_usage_unavailable: "ChatGPT couldn't check your plan's usage just now. Try again shortly.",
  subscription_sharing_user_unavailable: "Your ChatGPT account is temporarily unavailable. Try again shortly.",
  subscription_sharing_user_not_eligible: "This ChatGPT account can't share its plan with apps. Sign-in with ChatGPT needs an eligible Plus or Pro plan.",
  subscription_sharing_unsupported_capability: "ChatGPT's plan route doesn't support part of this request. Choose a model from another provider.",
  subscription_sharing_route_not_supported: "ChatGPT's plan route doesn't support this request. Choose a model from another provider.",
  subscription_sharing_invalid_user: SIGN_IN_AGAIN,
  chatpass_v2_scope_not_authorized: SIGN_IN_AGAIN,
  chatpass_v2_invalid_authorization_context: SIGN_IN_AGAIN,
};

/** OpenAI's error code in an API error's body, or in a streamed `response.failed` or `error` event. */
function openAiErrorCode(error: unknown): string | undefined {
  if (APICallError.isInstance(error)) {
    try {
      return errorCode(JSON.parse(error.responseBody ?? "")) ?? errorCode(error.data);
    } catch {
      return errorCode(error.data);
    }
  }
  if (error && typeof error === "object") return errorCode(error) ?? errorCode((error as { response?: unknown }).response);
  return undefined;
}

/**
 * An error message safe to show a client. Error text from providers can echo request content,
 * including private tool inputs such as a check's answer key, and an error's class doesn't
 * guarantee its message is safe. So clients only ever get server-owned messages, chosen by error
 * class and HTTP status; the original text stays server-side.
 */
export function publicErrorText(error: unknown): string {
  // After retries, the SDK wraps the last failure.
  if (RetryError.isInstance(error)) return publicErrorText(error.lastError);
  // ChatGPT sign-in errors carry messages Mivra wrote (ADR-015).
  if (error instanceof ChatGptError) return error.message;
  const code = openAiErrorCode(error);
  if (code && code in CHATGPT_ERRORS) return CHATGPT_ERRORS[code]!;
  // Configuration problems the learner can fix.
  if (LoadAPIKeyError.isInstance(error)) {
    return "The model provider's API key is missing. Set it in .env (see .env.example) and restart the server.";
  }
  if (NoSuchModelError.isInstance(error)) return "Unknown model or provider. Choose another model in the picker under the message box.";
  if (APICallError.isInstance(error)) {
    const hint = error.statusCode ? STATUS_HINTS[error.statusCode] : undefined;
    return hint
      ? `The model request failed: ${hint}.`
      : `The model request failed${error.statusCode ? ` (HTTP ${error.statusCode})` : ""}.`;
  }
  return "The model request failed.";
}
