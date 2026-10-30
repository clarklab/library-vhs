// New sessions use HttpOnly cookies. localStorage holds only a nonsecret marker
// for detecting account changes; legacy bearer credentials migrate at /auth/me.

const TOKEN_KEY = "vhsvault.token";
export const SCAN_REQUEST_TIMEOUT_MS = 120000;

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = `HTTP_${status}`;
    this.retryable = status === 0 || [408, 425, 429].includes(status) || status >= 500;
    this.retryAfterMs = 0;
  }
}

const boundedText = (value, limit = 600) => typeof value === "string" ? value
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "";
const retryDelay = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(86400000, Number(value))) : 0;
function retryHeader(value) {
  if (!value) return 0;
  return /^\d+(?:\.\d+)?$/.test(value.trim()) ? retryDelay(Number(value) * 1000) : retryDelay(Date.parse(value) - Date.now());
}
function platformMessage(status) {
  return {
    401: "Your sign-in has expired. Sign in again to continue.",
    403: "The server refused this request. Check your account access and try again.",
    404: "This service could not be found. The site may need to finish deploying before you try again.",
    408: "The server timed out. Your work is kept; try again.",
    413: "This photo is too large for the server. Choose a smaller photo or photograph a smaller section.",
    429: "The service is busy. Wait a moment before trying again.",
    502: "The server could not complete this request. Your work is kept; try again.",
    503: "The service is temporarily unavailable. Your work is kept; try again shortly.",
    504: "The server took too long to respond. Your work is kept; reconnect and check again.",
  }[status] || `The server could not complete this request (HTTP ${status}).`;
}
function errorDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of ["stage", "providerType", "providerRequestId"]) {
    const text = boundedText(value[field], 160);
    if (text) result[field] = text;
  }
  for (const field of ["durationMs", "providerStatus"]) if (Number.isFinite(value[field]) && value[field] >= 0) result[field] = value[field];
  return Object.keys(result).length ? result : null;
}
function diagnosticsText(value) {
  return value ? [value.stage && `Stage: ${value.stage}`, value.durationMs !== undefined && `Duration: ${value.durationMs} ms`, value.providerStatus && `Provider HTTP ${value.providerStatus}`, value.providerType, value.providerRequestId && `Provider request: ${value.providerRequestId}`].filter(Boolean).join(" · ") : "";
}

async function request(method, path, body, { signal, timeoutMs = 45000, expectedToken } = {}) {
  const headers = { "content-type": "application/json" };
  const token = getToken();
  if (expectedToken !== undefined && token !== expectedToken) throw Object.assign(new ApiError("Your account changed. Sign in again to continue this draft.", 401), { code: "ACCOUNT_CHANGED" });
  if (signal?.aborted) throw new DOMException("Request paused", "AbortError");
  if (token?.startsWith("cookie:")) headers["X-VHS-Session"] = token.slice(7);
  else if (/^[a-f0-9]{64}$/.test(token || "")) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  let responseRequestId = "";
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(path, {
      method, headers, signal: controller.signal, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    responseRequestId = boundedText(res.headers?.get?.("x-nf-request-id") || res.headers?.get?.("x-request-id"), 160);
    let data = null, raw = "";
    if (typeof res.text === "function") {
      raw = await res.text();
      try { data = JSON.parse(raw); } catch { /* Preserve a bounded platform reason below. */ }
    } else {
      // Lightweight test transports may expose only json().
      try { data = await res.json(); } catch { /* non-JSON error body */ }
    }
    const requestId = responseRequestId;
    if (!res.ok) {
      if (res.status === 401 && token && getToken() === token) {
        setToken(null);
        window.dispatchEvent(new CustomEvent("vhs:signed-out"));
      }
      const error = new ApiError(boundedText(data?.error) || platformMessage(res.status), res.status);
      error.code = boundedText(data?.code, 100) || `HTTP_${res.status}`;
      error.retryable = typeof data?.retryable === "boolean" ? data.retryable : error.retryable;
      error.retryAfterMs = Math.max(retryDelay(data?.retryAfterMs), retryHeader(res.headers?.get?.("retry-after")));
      error.requestId = boundedText(data?.requestId, 160) || requestId;
      error.diagnostics = errorDiagnostics(data?.errorDetails);
      error.details = diagnosticsText(error.diagnostics) || boundedText(data?.errorDetails || data?.details || (!data ? raw : ""));
      error.failures = data?.failures;
      throw error;
    }
    if (!data || typeof data !== "object") throw Object.assign(new ApiError("The server returned an unreadable response. Your work is kept; try again.", 502), { code: "INVALID_RESPONSE", requestId, details: boundedText(raw) });
    if (expectedToken !== undefined && getToken() !== token) throw Object.assign(new ApiError("Your account changed. Sign in again to continue.", 409), { code: "ACCOUNT_CHANGED" });
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Request paused", "AbortError");
    if (timedOut) {
      const timeout = new ApiError("This request took too long. Your work is kept; try again.", 408);
      timeout.code = "REQUEST_TIMEOUT";
      timeout.requestId = responseRequestId;
      timeout.retryable = true;
      throw timeout;
    }
    if (error instanceof ApiError) throw error;
    const offline = new ApiError("Connection interrupted. Check your connection and try again.", 0);
    offline.code = "NETWORK_ERROR";
    offline.retryable = true;
    throw offline;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const api = {
  signup: (email, password, options = {}) => request("POST", "/api/auth/signup", { email, password }, options),
  login: (email, password, options = {}) => request("POST", "/api/auth/login", { email, password }, options),
  logout: (options = {}) => request("POST", "/api/auth/logout", undefined, options),
  me: (options = {}) => request("GET", "/api/auth/me", undefined, options),
  updateProfile: (displayName, options = {}) => request("PATCH", "/api/auth/profile", { displayName }, options),
  changePassword: (currentPassword, newPassword, options = {}) => request("POST", "/api/auth/password", { currentPassword, newPassword }, options),
  recoveryCode: (currentPassword, options = {}) => request("POST", "/api/auth/recovery", { currentPassword }, options),
  resetPassword: (email, recoveryCode, newPassword, options = {}) => request("POST", "/api/auth/reset", { email, recoveryCode, newPassword }, options),
  logoutAll: (currentPassword, options = {}) => request("POST", "/api/auth/logout-all", { currentPassword }, options),

  listTapes: (options = {}) => request("GET", "/api/tapes", undefined, options),
  createTapes: (tapes, options = {}) => request("POST", "/api/tapes", { tapes }, options),
  updateTape: (id, patch, options = {}) => request("PATCH", `/api/tapes/${id}`, patch, options),
  deleteTape: (id) => request("DELETE", `/api/tapes/${id}`),

  scanPhoto: (imageDataUrl, { mode = "fast", sourceId, verificationContext, ...options } = {}) => request("POST", "/api/scan", { image: imageDataUrl, mode, sourceId, verificationContext }, { timeoutMs: SCAN_REQUEST_TIMEOUT_MS, ...options }),
  createScanJob: (payload, options = {}) => request("POST", "/api/scan-jobs", payload, { timeoutMs: 45000, ...options }),
  getScanJob: (id, options = {}) => request("GET", `/api/scan-jobs/${encodeURIComponent(id)}`, undefined, { timeoutMs: 45000, ...options }),
  enrich: (items, options = {}) => request("POST", "/api/enrich", { items }, { timeoutMs: 90000, ...options }),
  uploadCover: (tapeId, imageDataUrl) => request("POST", "/api/cover", { tapeId, image: imageDataUrl }),
  valueEstimate: (tape, options = {}) => request("POST", "/api/value", tape, { timeoutMs: 90000, ...options }),

  listScouts: (options = {}) => request("GET", "/api/scouts", undefined, options),
  getScout: (id, options = {}) => request("GET", `/api/scouts/${id}`, undefined, options),
  deleteScout: (id, options = {}) => request("DELETE", `/api/scouts/${id}`, undefined, options),
  createScout: (list, options = {}) => request("POST", "/api/scouts", list, options),
  updateScout: (id, patch, options = {}) => request("PATCH", `/api/scouts/${id}`, patch, options),

  getSettings: (options = {}) => request("GET", "/api/settings", undefined, options),
  saveSettings: (settings, options = {}) => request("PUT", "/api/settings", settings, options),

  backupManifest: (options = {}) => request("GET", "/api/backup", undefined, options),
  backupTapes: (cursor, options = {}) => request("GET", `/api/backup/tapes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, options),
  backupScout: (id, cursor, options = {}) => request("GET", `/api/backup/scouts/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, options),
  backupCover: (id, options = {}) => request("GET", `/api/backup/covers/${encodeURIComponent(id)}`, undefined, options),
  restoreBackup: (payload, options = {}) => request("POST", "/api/backup/restore", payload, { timeoutMs: 90000, ...options }),
};
