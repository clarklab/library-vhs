// New sessions use HttpOnly cookies. localStorage holds only a nonsecret marker
// for detecting account changes; legacy bearer credentials migrate at /auth/me.

const TOKEN_KEY = "vhsvault.token";

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
    this.status = status;
  }
}

async function request(method, path, body, { signal, timeoutMs = 45000, expectedToken } = {}) {
  const headers = { "content-type": "application/json" };
  const token = getToken();
  if (expectedToken !== undefined && token !== expectedToken) throw new ApiError("Your account changed. Sign in again to continue this draft.", 401);
  if (token?.startsWith("cookie:")) headers["X-VHS-Session"] = token.slice(7);
  else if (/^[a-f0-9]{64}$/.test(token || "")) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(path, {
      method, headers, signal: controller.signal, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      if (res.status === 401 && token && getToken() === token) {
        setToken(null);
        window.dispatchEvent(new CustomEvent("vhs:signed-out"));
      }
      const error = new ApiError(data?.error || `Request failed (${res.status})`, res.status);
      error.code = data?.code;
      error.retryable = data?.retryable ?? (res.status === 429 || res.status >= 500);
      error.retryAfterMs = data?.retryAfterMs || 0;
      error.failures = data?.failures;
      throw error;
    }
    if (!data) throw new ApiError("The server returned an incomplete response. Please retry.", 502);
    if (expectedToken !== undefined && getToken() !== token) throw new ApiError("Your account changed. Sign in again to continue.", 409);
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Request paused", "AbortError");
    if (timedOut) {
      const timeout = new ApiError("This request took too long. Your work is kept; try again.", 408);
      timeout.retryable = true;
      throw timeout;
    }
    if (error instanceof ApiError) throw error;
    const offline = new ApiError("Connection interrupted. Check your connection and try again.", 0);
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

  scanPhoto: (imageDataUrl, { mode = "fast", sourceId, verificationContext, ...options } = {}) => request("POST", "/api/scan", { image: imageDataUrl, mode, sourceId, verificationContext }, { timeoutMs: 120000, ...options }),
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
