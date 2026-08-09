// Minimal API client with bearer-token auth kept in localStorage.

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

async function request(method, path, body) {
  const headers = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("You appear to be offline. Check your connection.", 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      setToken(null);
      window.dispatchEvent(new CustomEvent("vhs:signed-out"));
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  signup: (email, password) => request("POST", "/api/auth/signup", { email, password }),
  login: (email, password) => request("POST", "/api/auth/login", { email, password }),
  logout: () => request("POST", "/api/auth/logout"),
  me: () => request("GET", "/api/auth/me"),

  listTapes: () => request("GET", "/api/tapes"),
  createTapes: (tapes) => request("POST", "/api/tapes", { tapes }),
  updateTape: (id, patch) => request("PATCH", `/api/tapes/${id}`, patch),
  deleteTape: (id) => request("DELETE", `/api/tapes/${id}`),

  scanPhoto: (imageDataUrl) => request("POST", "/api/scan", { image: imageDataUrl }),
  enrich: (items) => request("POST", "/api/enrich", { items }),

  getSettings: () => request("GET", "/api/settings"),
  saveSettings: (settings) => request("PUT", "/api/settings", settings),
};
