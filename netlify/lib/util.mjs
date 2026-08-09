import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------- stores ----------

export const usersStore = () => getStore({ name: "users", consistency: "strong" });
export const sessionsStore = () => getStore({ name: "sessions", consistency: "strong" });
export const tapesStore = () => getStore({ name: "tapes", consistency: "strong" });

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

// ---------- passwords ----------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---------- sessions ----------

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  await sessionsStore().setJSON(token, {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export async function destroySession(token) {
  if (token) await sessionsStore().delete(token);
}

/**
 * Resolves the authenticated user for a request, or null.
 * Returns { userId, email, token } on success.
 */
export async function requireAuth(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const session = await sessionsStore().get(token, { type: "json" });
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await sessionsStore().delete(token);
    return null;
  }
  const user = await usersStore().get(session.userId, { type: "json" });
  if (!user) return null;
  return { userId: session.userId, email: user.email, user, token };
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
