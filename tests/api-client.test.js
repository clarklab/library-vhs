import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../public/js/api.js";

function environment(token = "account-a") {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const events = [];
  globalThis.localStorage = { getItem: () => token, setItem: (_key, value) => { token = value; }, removeItem: () => { token = null; } };
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  return { events, setToken: (value) => { token = value; }, token: () => token, restore: () => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; globalThis.window = originalWindow; } };
}

test("a changed account rejects a pinned request before sending private photo or inventory data", async () => {
  const env = environment("different-account");
  try {
    globalThis.fetch = async () => assert.fail("Account mismatch must not send a request");
    await assert.rejects(api.scanPhoto("private-photo", { expectedToken: "original-account" }), (error) => error instanceof ApiError && error.status === 401);
    await assert.rejects(api.createTapes([{ title: "Private inventory" }], { expectedToken: "original-account" }), /account changed/);
    await assert.rejects(api.createScout({ items: [] }, { expectedToken: "original-account" }), /account changed/);
  } finally { env.restore(); }
});

test("pause aborts retain AbortError instead of becoming misleading offline failures", async () => {
  const env = environment();
  try {
    globalThis.fetch = async (_path, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
      else signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const controller = new AbortController();
    const pending = api.scanPhoto("photo", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally { env.restore(); }
});

test("request deadlines expose a retryable timeout", async () => {
  const env = environment();
  try {
    globalThis.fetch = async (_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError"))));
    await assert.rejects(api.scanPhoto("photo", { timeoutMs: 5 }), (error) => error.status === 408 && error.retryable === true);
  } finally { env.restore(); }
});

test("server retry hints and per-row failures survive client error translation", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: "Busy", code: "RATE_LIMITED", retryable: true, retryAfterMs: 3000, failures: [{ clientId: "a" }] }) });
    await assert.rejects(api.scanPhoto("photo"), (error) => error.code === "RATE_LIMITED" && error.retryAfterMs === 3000 && error.failures[0].clientId === "a");
  } finally { env.restore(); }
});

test("an expired response for the previous account cannot sign out the current account", async () => {
  const env = environment("original-account");
  try {
    globalThis.fetch = async () => {
      env.setToken("new-account");
      return { ok: false, status: 401, json: async () => ({ error: "Expired" }) };
    };
    await assert.rejects(api.listTapes(), /Expired/);
    assert.equal(env.token(), "new-account");
    assert.equal(env.events.length, 0);
  } finally { env.restore(); }
});

test("cookie sessions send only the nonsecret marker with same-origin credentials", async () => {
  const env = environment("cookie:marker");
  try {
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.headers["X-VHS-Session"], "marker");
      assert.equal(options.headers.authorization, undefined);
      return { ok: true, json: async () => ({ tapes: [] }) };
    };
    await api.listTapes();
  } finally { env.restore(); }
});

test("legacy bearer sessions can migrate through the account endpoint", async () => {
  const token = "a".repeat(64), env = environment(token);
  try {
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      return { ok: true, json: async () => ({ user: { id: "one" }, sessionId: "marker" }) };
    };
    assert.equal((await api.me({ expectedToken: token })).sessionId, "marker");
  } finally { env.restore(); }
});

test("successful late auth and backup responses cannot cross an account change", async () => {
  for (const call of [() => api.me({ expectedToken: "old" }), () => api.login("a@b.co", "secret", { expectedToken: "old" }), () => api.backupManifest({ expectedToken: "old" })]) {
    const env = environment("old");
    try {
      globalThis.fetch = async () => {
        env.setToken("new");
        return { ok: true, json: async () => ({ user: { id: "old" }, sessionId: "old" }) };
      };
      await assert.rejects(call(), (error) => error.status === 409);
      assert.equal(env.token(), "new");
    } finally { env.restore(); }
  }
});
