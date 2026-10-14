import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createAuthHandler } from "../netlify/functions/auth.mjs";
import { createSettingsHandler } from "../netlify/functions/settings.mjs";
import {
  validateNewPassword, hashPassword, verifyPassword, makeRecoveryCode, hashRecoveryCode,
  verifyRecoveryCode, updateUserRecord, publicUser,
} from "../netlify/lib/account.mjs";
import { requireAuth, sessionCookie } from "../netlify/lib/util.mjs";

const PASSWORD = "a long correct password";
const PASS_HASH = hashPassword(PASSWORD);
const USER = { id: "user-a", email: "owner@example.com", displayName: "Alex", passHash: PASS_HASH, settings: {}, sessionVersion: 0, createdAt: "2026-10-14T12:00:00Z" };
const TOKEN = "a".repeat(64), MARKER = "b".repeat(32);
class Store {
  data = new Map();
  serial = 0;
  beforeSet = null;
  async get(key) { return structuredClone(this.data.get(key)?.value || null); }
  async getWithMetadata(key) { const item = this.data.get(key); return item ? { data: structuredClone(item.value), etag: item.etag } : null; }
  put(key, value) { this.data.set(key, { value: structuredClone(value), etag: String(++this.serial) }); }
  async setJSON(key, value, options = {}) {
    if (this.beforeSet) await this.beforeSet(key, value, options);
    const old = this.data.get(key);
    // Reproduce the installed SDK's false-positive conditional write result.
    if (options.onlyIfNew && old) return { modified: true };
    if (options.onlyIfMatch && old?.etag !== options.onlyIfMatch) return { modified: true };
    this.put(key, value);
    return { modified: true };
  }
  async delete(key) { this.data.delete(key); }
}
function fixture({ seeded = true } = {}) {
  const users = new Store(), sessions = new Store();
  if (seeded) {
    users.put(USER.id, USER); users.put(`email/${USER.email}`, { userId: USER.id });
    sessions.put(TOKEN, { userId: USER.id, sessionId: MARKER, sessionVersion: 0, expiresAt: Date.now() + 3600000 });
  }
  const dependencies = { getUsers: () => users, getSessions: () => sessions };
  return { users, sessions, auth: createAuthHandler(dependencies), settings: createSettingsHandler(dependencies) };
}
function request(action, body, { method = body === undefined ? "GET" : "POST", cookie = `__Host-vhs_session=${TOKEN}`, marker = MARKER, origin = "https://vault.test", bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (marker) headers["x-vhs-session"] = marker;
  if (origin) headers.origin = origin;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request(`https://vault.test/api/auth/${action}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const publicCookie = (res) => res.headers.get("set-cookie")?.split(";")[0];
const anonymous = { cookie: "", marker: "" };

test("new passwords have explicit bounds; legacy scrypt passwords still authenticate", () => {
  assert.throws(() => validateNewPassword("12345678901"));
  assert.throws(() => validateNewPassword("x".repeat(129)));
  assert.equal(validateNewPassword("space rich passphrase"), "space rich passphrase");
  const salt = "c".repeat(32);
  const old = `${salt}:${scryptSync("oldpass8", salt, 64).toString("hex")}`;
  assert.equal(verifyPassword("oldpass8", old), true);
  assert.equal(verifyPassword("badpass8", old), false);
  assert.equal(verifyPassword(PASSWORD, PASS_HASH), true);
  assert.equal(verifyPassword("x".repeat(1025), PASS_HASH), false);
  assert.equal(verifyPassword(PASSWORD, "corrupt"), false);
});

test("recovery codes have high entropy, tolerate formatting and never expose their hash", () => {
  const code = makeRecoveryCode();
  const hash = hashRecoveryCode(code);
  assert.equal(verifyRecoveryCode(code.toLowerCase().replaceAll("-", " "), hash), true);
  assert.equal(verifyRecoveryCode(makeRecoveryCode(), hash), false);
  assert.equal(verifyRecoveryCode("short", hash), false);
  const user = publicUser({ ...USER, recoveryHash: hash });
  assert.equal(user.hasRecoveryCode, true);
  assert.equal("recoveryHash" in user, false);
  assert.equal("passHash" in user, false);
  assert.equal("sessionVersion" in user, false);
});

test("signup returns one recovery code and a nonsecret marker; actual token is only HttpOnly cookie", async () => {
  const { auth, users, sessions } = fixture({ seeded: false });
  const res = await auth(request("signup", { email: "NEW@EXAMPLE.COM", password: PASSWORD, displayName: "  Casey  " }, anonymous));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.email, "new@example.com");
  assert.equal(body.user.displayName, "Casey");
  assert.match(body.sessionId, /^[a-f0-9]{32}$/);
  assert.equal("token" in body, false);
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  assert.match(res.headers.get("set-cookie"), /Secure/);
  assert.match(res.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const user = await users.get(body.user.id);
  assert.equal(verifyRecoveryCode(body.recoveryCode, user.recoveryHash), true);
  const authResult = await requireAuth(request("me", undefined, { cookie: publicCookie(res), marker: body.sessionId }), { users, sessions });
  assert.equal(authResult.userId, body.user.id);
  assert.equal(body.sessionId === authResult.token, false);
});

test("concurrent signup confirms the actual email owner even when onlyIfNew falsely reports success", async () => {
  const { auth, users } = fixture({ seeded: false });
  const signup = () => auth(request("signup", { email: "same@example.com", password: PASSWORD }, anonymous));
  const responses = await Promise.all([signup(), signup()]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [201, 409]);
  const owner = await users.get("email/same@example.com");
  assert.ok(await users.get(owner.userId));
  assert.equal([...users.data.keys()].filter((key) => !key.startsWith("email/")).length, 1);
});

test("legacy bearer sessions migrate to a cookie without returning the token", async () => {
  const { auth, sessions } = fixture();
  sessions.put(TOKEN, { userId: USER.id, expiresAt: Date.now() + 3600000 });
  const res = await auth(request("me", undefined, { cookie: "", marker: "", bearer: TOKEN }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), new RegExp(TOKEN));
  const body = await res.json();
  assert.equal("token" in body, false);
  assert.match(body.sessionId, /^[a-f0-9]{32}$/);
});

test("cookie mutations require same-origin requests and wrong session markers cannot act on another cookie", async () => {
  const { auth, users, sessions } = fixture();
  const crossOrigin = request("profile", { displayName: "Attacker" }, { method: "PATCH", origin: "https://evil.test" });
  assert.equal((await auth(crossOrigin)).status, 403);
  assert.equal(await requireAuth(crossOrigin, { users, sessions }), null);
  assert.equal((await auth(request("profile", { displayName: "Attacker" }, { method: "PATCH", origin: "" }))).status, 403);
  const swapped = await auth(request("logout", {}, { marker: "wrong-marker" }));
  assert.equal(swapped.status, 409);
  assert.ok(await sessions.get(TOKEN));
  assert.equal((await users.get(USER.id)).displayName, "Alex");
});

test("login cannot be CSRF-triggered by a cross-origin JSON or form request", async () => {
  const { auth } = fixture();
  assert.equal((await auth(request("login", { email: USER.email, password: PASSWORD }, { ...anonymous, origin: "https://evil.test" }))).status, 403);
  const form = new Request("https://vault.test/api/auth/login", { method: "POST", body: "email=test", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal((await auth(form)).status, 415);
});

test("wrong current password is403 and does not sign out the valid session", async () => {
  const { auth, sessions, users } = fixture();
  const res = await auth(request("password", { currentPassword: "incorrect", newPassword: "my replacement password" }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CURRENT_PASSWORD_INCORRECT");
  assert.ok(await requireAuth(request("me"), { users, sessions }));
});

test("password change rotates the cookie and revokes every earlier bearer or cookie session", async () => {
  const { auth, users, sessions } = fixture();
  const second = "d".repeat(64);
  sessions.put(second, { userId: USER.id, expiresAt: Date.now() + 3600000 });
  const res = await auth(request("password", { currentPassword: PASSWORD, newPassword: "my replacement password" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.sessionId, MARKER);
  assert.equal(await requireAuth(request("me"), { users, sessions }), null);
  assert.equal(await requireAuth(request("me", undefined, { ...anonymous, bearer: second }), { users, sessions }), null);
  assert.ok(await requireAuth(request("me", undefined, { cookie: publicCookie(res), marker: body.sessionId }), { users, sessions }));
  assert.equal(verifyPassword("my replacement password", (await users.get(USER.id)).passHash), true);
});

test("regenerating a recovery code requires current password and invalidates the old code", async () => {
  const { auth, users } = fixture();
  const old = makeRecoveryCode(); users.put(USER.id, { ...USER, recoveryHash: hashRecoveryCode(old) });
  assert.equal((await auth(request("recovery", { currentPassword: "wrong" }))).status, 403);
  const res = await auth(request("recovery", { currentPassword: PASSWORD }));
  assert.equal(res.status, 200);
  const body = await res.json(); const user = await users.get(USER.id);
  assert.equal(verifyRecoveryCode(old, user.recoveryHash), false);
  assert.equal(verifyRecoveryCode(body.recoveryCode, user.recoveryHash), true);
});

test("recovery is consumed atomically; concurrent reuse cannot reset the account twice", async () => {
  const { auth, users, sessions } = fixture();
  const code = makeRecoveryCode(); users.put(USER.id, { ...USER, recoveryHash: hashRecoveryCode(code) });
  const reset = () => auth(request("reset", { email: USER.email, recoveryCode: code, newPassword: "my recovered password" }, anonymous));
  const responses = await Promise.all([reset(), reset()]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 403]);
  const success = responses.find((res) => res.status === 200);
  const body = await success.json();
  assert.equal(verifyRecoveryCode(body.recoveryCode, (await users.get(USER.id)).recoveryHash), true);
  assert.equal(await requireAuth(request("me"), { users, sessions }), null);
  assert.ok(await requireAuth(request("me", undefined, { cookie: publicCookie(success), marker: body.sessionId }), { users, sessions }));
});

test("sign out everywhere revokes all prior sessions and clears the browser cookie", async () => {
  const { auth, users, sessions } = fixture();
  const res = await auth(request("logout-all", { currentPassword: PASSWORD }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(await requireAuth(request("me"), { users, sessions }), null);
});

test("fresh CAS profile/settings merges never overwrite a concurrent credential revocation", async () => {
  const { settings, users } = fixture();
  let changed = false;
  users.beforeSet = (key, _value, options) => {
    if (key === USER.id && options.onlyIfMatch && !changed) {
      changed = true;
      users.put(USER.id, { ...USER, passHash: "new-protected-password", sessionVersion: 1 });
    }
  };
  const req = request("settings", { omdbKey: "abc123" }, { method: "PATCH" });
  const res = await settings(req);
  assert.equal(res.status, 401);
  const user = await users.get(USER.id);
  assert.equal(user.passHash, "new-protected-password");
  assert.equal(user.sessionVersion, 1);
  assert.equal(user.settings.omdbKey, undefined);
});

test("CAS retry merges concurrent profile and settings changes without dropping either", async () => {
  const { auth, settings, users } = fixture();
  const responses = await Promise.all([
    auth(request("profile", { displayName: "Casey" }, { method: "PATCH" })),
    settings(request("settings", { omdbKey: "abc123" }, { method: "PATCH" })),
  ]);
  assert.deepEqual(responses.map((res) => res.status), [200, 200]);
  const user = await users.get(USER.id);
  assert.equal(user.displayName, "Casey");
  assert.equal(user.settings.omdbKey, "abc123");
  assert.equal(user.passHash, PASS_HASH);
  assert.equal(user.sessionVersion, 0);
});

test("CAS confirms a committed change even if the write response was lost", async () => {
  const { users } = fixture();
  const original = users.setJSON.bind(users);
  users.setJSON = async (...args) => { await original(...args); throw new Error("Lost acknowledgement"); };
  const user = await updateUserRecord({ store: users, userId: USER.id, change: (current) => ({ ...current, displayName: "Saved" }) });
  assert.equal(user.displayName, "Saved");
});

test("local development cookies work on localhost; nonlocal production cookies always remain Secure", () => {
  assert.match(sessionCookie(new Request("http://localhost:8888/api/auth/login"), TOKEN), /^vhs_session=/);
  assert.doesNotMatch(sessionCookie(new Request("http://localhost:8888/api/auth/login"), TOKEN), /; Secure/);
  assert.match(sessionCookie(new Request("http://vault.test/api/auth/login"), TOKEN), /; Secure/);
});
