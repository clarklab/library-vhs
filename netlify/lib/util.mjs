import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";
import { sessionVersion } from "./account.mjs";
export { hashPassword, verifyPassword, updateUserRecord } from "./account.mjs";

// ---------- stores ----------

export const usersStore = () => getStore({ name: "users", consistency: "strong" });
export const sessionsStore = () => getStore({ name: "sessions", consistency: "strong" });
export const tapesStore = () => getStore({ name: "tapes", consistency: "strong" });
export const coversStore = () => getStore({ name: "covers", consistency: "strong" });

// ---------- responses ----------

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

// ---------- sessions ----------

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const TOKEN_RE = /^[a-f0-9]{64}$/;
const COOKIE_NAME = "__Host-vhs_session";
const LOCAL_COOKIE_NAME = "vhs_session";

export async function createSession(userId, version = 0, store = sessionsStore()) {
  const token = randomBytes(32).toString("hex");
  const session = {
    userId,
    sessionId: randomBytes(16).toString("hex"),
    sessionVersion: version,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  let writeError;
  try { await store.setJSON(token, session, { onlyIfNew: true }); } catch (error) { writeError = error; }
  const confirmed = await store.get(token, { type: "json", consistency: "strong" });
  if (confirmed?.sessionId !== session.sessionId || confirmed?.userId !== userId) throw writeError || new Error("Session creation could not be confirmed.");
  return { token, ...session };
}

export async function destroySession(token, store = sessionsStore()) {
  if (TOKEN_RE.test(token || "")) await store.delete(token);
}

export function requestSession(req) {
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    return TOKEN_RE.test(token) ? { token, source: "bearer" } : null;
  }
  const cookies = (req.headers.get("cookie") || "").slice(0, 8192).split(";");
  const url = new URL(req.url);
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  for (const name of [COOKIE_NAME, ...(isLocal ? [LOCAL_COOKIE_NAME] : [])]) {
    const cookie = cookies.find((part) => part.trim().startsWith(`${name}=`));
    const token = cookie?.trim().slice(name.length + 1);
    if (TOKEN_RE.test(token || "")) return { token, source: "cookie" };
  }
  return null;
}

export function sessionCookie(req, token = "", { clear = false } = {}) {
  const url = new URL(req.url);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return `${localHttp ? LOCAL_COOKIE_NAME : COOKIE_NAME}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}${localHttp ? "" : "; Secure"}`;
}

export function sameOriginMutation(req, { requireOrigin = false } = {}) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(req.url).origin; } catch { return false; }
  }
  if (["cross-site", "same-site"].includes(req.headers.get("sec-fetch-site"))) return false;
  return !requireOrigin;
}

export function sessionMarker(token, session) {
  return session.sessionId || createHash("sha256").update(`vhs-public-session:${token}`).digest("hex").slice(0, 32);
}

/**
 * Resolves the authenticated user for a request, or null.
 * Returns { userId, email, token } on success.
 */
export async function requireAuth(req, stores = {}) {
  const credential = requestSession(req);
  if (!credential) return null;
  if (credential.source === "cookie" && !sameOriginMutation(req, { requireOrigin: true })) return null;
  const { token } = credential;
  const sessions = stores.sessions || sessionsStore();
  const users = stores.users || usersStore();
  const session = await sessions.get(token, { type: "json", consistency: "strong" });
  if (!session) return null;
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    await sessions.delete(token);
    return null;
  }
  const sessionId = sessionMarker(token, session);
  const expected = req.headers.get("x-vhs-session");
  if (expected && expected !== sessionId) return null;
  const user = await users.get(session.userId, { type: "json", consistency: "strong" });
  if (!user || user.id !== session.userId || sessionVersion(session) !== sessionVersion(user)) return null;
  return { userId: session.userId, email: user.email, user, token, sessionId, authSource: credential.source };
}

// ---------- misc ----------

export function newId() {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The user's own OMDb key, else the site-wide key from any common env-var spelling. */
export function getOmdbKey(auth) {
  return (
    auth?.user?.settings?.omdbKey ||
    process.env.OMDB_API_KEY ||
    process.env.OMDB_KEY ||
    process.env.omdb ||
    process.env.OMDB ||
    ""
  );
}

/** Parses a JSON request body, always yielding a plain object. */
export async function readBody(req) {
  const raw = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
