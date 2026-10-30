import Anthropic from "@anthropic-ai/sdk";

// Netlify AI Gateway injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL.
// These identifiers are supported by the Gateway and Claude API (October 2026).
// Keep overrides server-side; a browser cannot choose an arbitrary paid model.
export const MODEL = process.env.VHS_AI_MODEL || "claude-sonnet-5-5";
export const THOROUGH_MODEL = process.env.VHS_AI_THOROUGH_MODEL || "claude-opus-5-5";

let _client;
export function anthropic() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export class FriendlyError extends Error {
  constructor(message, status = 502, { code = "AI_ERROR", retryable = false, retryAfterMs = 0, diagnostics = {} } = {}) {
    super(message);
    this.name = "FriendlyError";
    this.friendly = true;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.diagnostics = diagnostics;
  }
}

// Only these bounded identifiers/categories may leave the server. SDK errors
// also contain request bodies and arbitrary upstream HTML: never serialize them.
export const safeRequestId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const PROVIDER_TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error"]);
const STAGES = new Set(["authentication", "upload", "queued", "reading", "counting", "verifying", "identification", "count", "reconciliation"]);
export function safeAiDiagnostics(error, context = {}) {
  const source = error?.diagnostics || {};
  const providerStatus = source.providerStatus ?? (error?.friendly ? undefined : error?.status);
  const providerType = source.providerType ?? error?.type ?? error?.error?.type;
  const providerRequestId = safeRequestId(source.providerRequestId ?? error?.requestID ?? error?.headers?.get?.("request-id"));
  return {
    ...(Number.isInteger(providerStatus) && providerStatus >= 400 && providerStatus <= 599 ? { providerStatus } : {}),
    ...(PROVIDER_TYPES.has(providerType) ? { providerType } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(STAGES.has(context.stage) ? { stage: context.stage } : {}),
    ...(Number.isFinite(context.durationMs) ? { durationMs: Math.max(0, Math.round(context.durationMs)) } : {}),
  };
}

/** A real wall-clock deadline, including clients that do not settle on abort. */
export function withDeadline(operation, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const stop = (error) => {
      controller.abort(error);
      finish(reject, error);
    };
    const abort = () => stop(signal?.reason?.friendly ? signal.reason : normalizeAiError({ name: "AbortError" }));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop(normalizeAiError({ name: "TimeoutError" })), Math.max(0, timeoutMs));
    // Attach both continuations immediately so a late rejection after a timeout
    // cannot become an unhandled rejection or replace the response already sent.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    }).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

const invalidResponse = () => new FriendlyError(
  "The scanner returned an incomplete response. Retry this photo; your other scans are safe.",
  502,
  { code: "AI_INVALID_RESPONSE", retryable: true },
);

/** Validate the JSON Schema subset used by all three AI endpoints locally too. */
export function matchesSchema(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  });
  if (!matchesType || (schema.enum && !schema.enum.includes(value))) return false;
  if (Array.isArray(value)) return value.every((item) => matchesSchema(item, schema.items));
  if (value !== null && typeof value === "object") {
    const properties = schema.properties || {};
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !properties[key] || matchesSchema(item, properties[key]));
  }
  return true;
}

export function parseStructuredResponse(response, schema, { sanitize } = {}) {
  if (response?.stop_reason === "refusal") {
    throw new FriendlyError("The scanner could not read this image. Try a different photo.", 422, { code: "AI_REFUSAL" });
  }
  if (["max_tokens", "model_context_window_exceeded"].includes(response?.stop_reason)) {
    throw new FriendlyError("There is too much in this photo to finish reliably. Take closer photos of smaller sections.", 422, { code: "AI_TRUNCATED" });
  }
  // A valid-looking JSON fragment is not evidence that the model finished.
  if (response?.stop_reason !== "end_turn") throw invalidResponse();
  if (!Array.isArray(response.content)) throw invalidResponse();
  const text = response.content.filter((block) => block?.type === "text").map((block) => block.text).join("");
  let result;
  try { result = JSON.parse(text); } catch { throw invalidResponse(); }
  if (sanitize) result = sanitize(result);
  if (!matchesSchema(result, schema)) throw invalidResponse();
  return result;
}

function retryDelay(err) {
  const headers = err?.headers;
  const milliseconds = Number(headers?.get?.("retry-after-ms"));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds);
  const raw = headers?.get?.("retry-after");
  if (raw) {
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return Math.ceil(delay);
  }
  return 1200;
}

export function normalizeAiError(err) {
  if (err?.friendly) return err;
  const diagnostics = safeAiDiagnostics(err);
  if (["AbortError", "APIUserAbortError"].includes(err?.name)) {
    return new FriendlyError("Scanning was stopped. Your completed photos are safe.", 499, { code: "SCAN_CANCELLED", diagnostics });
  }
  if (["APIConnectionTimeoutError", "TimeoutError"].includes(err?.name)) {
    return new FriendlyError("This scan took longer than its time limit. Retry this photo; completed readings are kept.", 504, { code: "AI_TIMEOUT", retryable: true, retryAfterMs: 1500, diagnostics });
  }
  if (err?.status === 429) {
    return new FriendlyError("The scanner is busy. This photo can retry after a short pause.", 429, { code: "AI_RATE_LIMITED", retryable: true, retryAfterMs: retryDelay(err), diagnostics });
  }
  if ([401, 403].includes(err?.status) || /apiKey|api_key|authentication method/i.test(err?.message || "")) {
    return new FriendlyError("AI Gateway is unavailable. Check that this Netlify site has AI features enabled and a production deployment.", 503, { code: "AI_UNAVAILABLE", diagnostics });
  }
  if ([400, 404].includes(err?.status)) {
    return new FriendlyError("The scanner could not accept this request. Check the configured AI model, or try a new JPEG photo.", 502, { code: "AI_CONFIGURATION", diagnostics });
  }
  const transient = [408, 409, 500, 502, 503, 504, 529].includes(err?.status) || err?.name === "APIConnectionError";
  return new FriendlyError("The scanner could not finish this photo. Retry it when the connection is available.", 502, {
    code: "AI_SERVICE_ERROR", retryable: transient, retryAfterMs: transient ? retryDelay(err) : 0, diagnostics,
  });
}

/**
 * One structured call, with at most one retry after a quick transient failure.
 * Every attempt shares a single wall-clock deadline below Netlify's 60s limit.
 * Timeouts, invalid output and truncation are never silently retried here.
 */
export async function structured({
  system, content, schema, maxTokens = 8000, effort = "low", timeoutMs = 48000,
  model = MODEL, signal, client, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sanitizeResponse, longRunning = false,
}) {
  // Only background workers opt in. Stream the upstream response so long model
  // generations do not rely on a single buffered HTTP response staying open.
  const deadline = Date.now() + Math.min(timeoutMs, longRunning ? 300000 : 48000);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw normalizeAiError({ name: "AbortError" });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw normalizeAiError({ name: "TimeoutError" });
    let response;
    try {
      response = await withDeadline((requestSignal) => {
        const provider = client || anthropic();
        const payload = {
          model,
          max_tokens: maxTokens,
          system,
          // Adaptive thinking is the current API for Sonnet/Opus 5.5.
          thinking: { type: "adaptive" },
          output_config: { effort, format: { type: "json_schema", schema } },
          messages: [{ role: "user", content }],
        };
        const options = { timeout: remaining, maxRetries: 0, signal: requestSignal };
        return longRunning
          ? provider.messages.stream(payload, options).finalMessage()
          : provider.messages.create(payload, options);
      }, { timeoutMs: remaining, signal });
    } catch (err) {
      const friendly = normalizeAiError(err);
      const delay = friendly.retryAfterMs || 1200;
      if (attempt === 0 && friendly.retryable && friendly.code !== "AI_TIMEOUT" &&
        delay <= 2000 && deadline - Date.now() - delay >= 10000 && !signal?.aborted) {
        await sleep(delay);
        continue;
      }
      throw friendly;
    }
    return parseStructuredResponse(response, schema, { sanitize: sanitizeResponse });
  }
}

export function aiErrorResponse(err, context = {}) {
  const error = normalizeAiError(err);
  const requestId = safeRequestId(context.requestId);
  const errorDetails = safeAiDiagnostics(error, context);
  // Never write provider request bodies (which contain private photos) to logs.
  console.error("AI request failed:", { code: error.code, status: error.status, requestId, ...errorDetails });
  return new Response(JSON.stringify({
    error: error.message, code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs,
    ...(requestId ? { requestId } : {}), errorDetails,
  }), {
    status: error.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
      ...(error.retryAfterMs > 0 ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : {}),
    },
  });
}
