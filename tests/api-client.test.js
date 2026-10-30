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

test("non-JSON platform timeouts expose an actionable reason and request ID", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => new Response('<html><style>secret-style</style><h1>Gateway Timeout</h1><p>Function timed out.</p><script>secret-script</script></html>', {
      status: 504, headers: { "content-type": "text/html", "x-nf-request-id": "platform-request-123", "retry-after": "3" },
    });
    await assert.rejects(api.scanPhoto("photo"), (error) => {
      assert.equal(error.status, 504); assert.equal(error.code, "HTTP_504"); assert.equal(error.retryable, true);
      assert.match(error.message, /reconnect and check again/);
      assert.equal(error.requestId, "platform-request-123"); assert.equal(error.retryAfterMs, 3000);
      assert.equal(error.details, "Gateway Timeout Function timed out.");
      return true;
    });
  } finally { env.restore(); }
});

test("oversize and permanent configuration failures do not become blind retry requests", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => new Response("Payload too large", { status: 413 });
    await assert.rejects(api.scanPhoto("photo"), (error) => error.code === "HTTP_413" && error.retryable === false && /smaller photo/.test(error.message));
    globalThis.fetch = async () => Response.json({ error: "Gateway configuration needs attention", code: "AI_CONFIGURATION", retryable: false, requestId: "backend-id", errorDetails: "Model is unavailable" }, { status: 502 });
    await assert.rejects(api.scanPhoto("photo"), (error) => error.retryable === false && error.requestId === "backend-id" && error.details === "Model is unavailable");
  } finally { env.restore(); }
});

test("an HTML success response is an error rather than an empty successful scan", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => new Response("<h1>Site not found</h1>" + "x".repeat(1000), { status: 200 });
    await assert.rejects(api.scanPhoto("photo"), (error) => error.code === "INVALID_RESPONSE" && error.retryable === true && error.details.length === 600);
  } finally { env.restore(); }
});

test("already-paused calls send no request and preserve an AbortError", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => assert.fail("An already-aborted request must not upload a photo");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.scanPhoto("photo", { signal: controller.signal }), (error) => error.name === "AbortError");
  } finally { env.restore(); }
});

test("safe backend diagnostic fields remain structured and readable without retaining arbitrary data", async () => {
  const env = environment();
  try {
    globalThis.fetch = async () => Response.json({ error: "Timed out", code: "AI_TIMEOUT", retryable: true, errorDetails: { stage: "identification", durationMs: 38000, providerStatus: 504, providerType: "timeout", providerRequestId: "provider-123", rawPhoto: "must-not-copy" } }, { status: 504 });
    await assert.rejects(api.scanPhoto("photo"), (error) => {
      assert.deepEqual(error.diagnostics, { stage: "identification", durationMs: 38000, providerStatus: 504, providerType: "timeout", providerRequestId: "provider-123" });
      assert.match(error.details, /Stage: identification.*Duration: 38000 ms/);
      assert.equal(error.details.includes("must-not-copy"), false);
      return true;
    });
  } finally { env.restore(); }
});

test("background job creation and polling use authenticated account-pinned endpoints", async () => {
  const env = environment("cookie:job-owner");
  const requests = [];
  try {
    globalThis.fetch = async (path, options) => { requests.push({ path, ...options }); return Response.json({ job: { id: "job-one", status: "queued" } }); };
    await api.createScanJob({ image: "photo", clientId: "stable-key", sourceId: "source-one", mode: "fast" }, { expectedToken: "cookie:job-owner" });
    await api.getScanJob("job-one", { expectedToken: "cookie:job-owner" });
    assert.equal(requests[0].path, "/api/scan-jobs"); assert.equal(requests[0].method, "POST"); assert.equal(JSON.parse(requests[0].body).clientId, "stable-key");
    assert.equal(requests[1].path, "/api/scan-jobs/job-one"); assert.equal(requests[1].method, "GET");
    assert.equal(requests.every((request) => request.headers["X-VHS-Session"] === "job-owner"), true);
    env.setToken("cookie:another-owner");
    await assert.rejects(api.getScanJob("job-one", { expectedToken: "cookie:job-owner" }), /account changed/);
    assert.equal(requests.length, 2);
  } finally { env.restore(); }
});
