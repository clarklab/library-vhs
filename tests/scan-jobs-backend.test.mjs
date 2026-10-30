import test from "node:test";
import assert from "node:assert/strict";
import { structured, withDeadline, aiErrorResponse, normalizeAiError } from "../netlify/lib/ai.mjs";
import { SCAN_SCHEMA, COUNT_SCHEMA } from "../netlify/lib/scan-contract.mjs";
import { scanPhoto, processScanJob } from "../netlify/lib/scan-processor.mjs";
import { createScanHandler } from "../netlify/functions/scan.mjs";
import { createScanJobsHandler, dispatchScanJob, workerURL } from "../netlify/functions/scan-jobs.mjs";
import { createScanWorker, config as workerConfig } from "../netlify/functions/scan-worker-background.mjs";
import { createScanJobStore } from "../netlify/lib/scan-job-store.mjs";

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5xkAAAAASUVORK5CYII=";
const tape = { title: "Alien", format: "VHS", year: 1979, confidence: "high", visual: "Left black spine", edition: "", marker: { x: 0.2, y: 0.7 } };
const reading = { count: 1, tapes: [tape], notes: "" };
const counted = { count: 1, positions: [{ label: "Left box", marker: tape.marker }], uncertainCount: 0, notes: "" };
const providerResponse = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reading) }] };
const request = (body, path = "/api/scan-jobs") => new Request(`https://example.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("hard deadline settles even when a provider ignores cancellation", async () => {
  let aborted = false;
  await assert.rejects(withDeadline((signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {});
  }, { timeoutMs: 10 }), (error) => error.code === "AI_TIMEOUT");
  assert.equal(aborted, true);
});

test("long background requests stream and keep a longer bounded deadline", async () => {
  let streamed = false;
  const client = { messages: {
    create: () => { throw new Error("Buffered transport must not run"); },
    stream: (payload, options) => {
      streamed = true;
      assert.ok(options.timeout > 48000 && options.timeout <= 240000);
      assert.equal(options.maxRetries, 0);
      assert.equal(payload.output_config.format.schema, SCAN_SCHEMA);
      return { finalMessage: async () => providerResponse };
    },
  } };
  assert.deepEqual(await structured({ system: "test", content: [], schema: SCAN_SCHEMA, client, longRunning: true, timeoutMs: 240000 }), reading);
  assert.equal(streamed, true);
});

test("the compatibility route bounds auth and never starts inference after a late auth response", async (t) => {
  t.mock.method(console, "error", () => {});
  let finishAuth;
  let calls = 0;
  const handler = createScanHandler({ authenticate: () => new Promise((resolve) => { finishAuth = resolve; }), runStructured: async () => { calls++; }, timeoutMs: 10 });
  const res = await handler(request({ image: PHOTO }), { requestId: "req_auth_timeout" });
  const body = await res.json();
  assert.equal(res.status, 504);
  assert.equal(body.requestId, "req_auth_timeout");
  assert.equal(body.errorDetails.stage, "authentication");
  finishAuth({ userId: "owner" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
});

test("safe diagnostics retain provider correlation without exposing raw errors or headers", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const res = aiErrorResponse(normalizeAiError({ status: 503, type: "overloaded_error", requestID: "req_provider_123", message: PHOTO, headers: new Headers({ authorization: "secret-token" }) }), { requestId: "req_app", stage: "identification", durationMs: 20 });
  const body = await res.json();
  assert.deepEqual(body.errorDetails, { providerStatus: 503, providerType: "overloaded_error", providerRequestId: "req_provider_123", stage: "identification", durationMs: 20 });
  assert.equal(JSON.stringify([body, logs]).includes(PHOTO), false);
  assert.equal(JSON.stringify([body, logs]).includes("secret-token"), false);
});

test("a failed title reader immediately cancels the independent count", async () => {
  let counterAborted = false;
  await assert.rejects(scanPhoto({ image: PHOTO }, { longRunning: true, runStructured: async (options) => {
    if (options.schema === SCAN_SCHEMA) throw { status: 503 };
    options.signal.addEventListener("abort", () => { counterAborted = true; });
    return new Promise(() => {});
  } }));
  assert.equal(counterAborted, true);
});

test("background jobs publish initial evidence then preserve it when verification fails", async () => {
  const updates = [];
  const calls = [];
  const result = await processScanJob({ image: PHOTO, sourceId: "photo-1" }, { requestId: "job_request", onProgress: async (patch) => updates.push(patch), runStructured: async (options) => {
    calls.push(options);
    assert.equal(options.longRunning, true);
    assert.ok(options.timeoutMs > 48000);
    if (options.model.includes("opus")) throw { status: 503 };
    return options.schema === COUNT_SCHEMA ? { ...counted, uncertainCount: 1 } : reading;
  } });
  assert.equal(calls.length, 4);
  assert.equal(updates.some((patch) => patch.stage === "verifying" && patch.result.tapes[0].title === "Alien"), true);
  assert.equal(result.tapes[0].title, "Alien");
  assert.equal(result.sourceId, "photo-1");
  assert.equal(result.needsVerification, true);
  assert.equal(result.verificationFailure.code, "AI_SERVICE_ERROR");
  assert.equal(result.verification.uncertainCount, 1);
});

test("a clear first reading finishes without paying for an extra verifier", async () => {
  let calls = 0;
  const result = await processScanJob({ image: PHOTO }, { runStructured: async (options) => { calls++; return options.schema === COUNT_SCHEMA ? counted : reading; } });
  assert.equal(calls, 2);
  assert.equal(result.needsVerification, false);
});

test("worker destination is trusted deployment configuration, never the request host", () => {
  const req = new Request("https://attacker.example/api/scan-jobs");
  assert.equal(workerURL(req, { DEPLOY_URL: "https://deploy-id.netlify.app" }), "https://deploy-id.netlify.app/.netlify/functions/scan-worker-background");
  assert.equal(workerURL(req, { URL: "https://production.example" }, { deploy: { id: "0123456789abcdef01234567" }, site: { name: "library-vhs" } }), "https://0123456789abcdef01234567--library-vhs.netlify.app/.netlify/functions/scan-worker-background");
  assert.throws(() => workerURL(req, {}), (error) => error.code === "SCAN_WORKER_UNAVAILABLE");
  assert.throws(() => workerURL(req, { NETLIFY_DEV: "true" }), (error) => error.code === "SCAN_WORKER_UNAVAILABLE");
});

test("dispatch requires Netlify's async202 and sends no photo or user session", async () => {
  const args = { req: request({ image: PHOTO }), jobId: "job-1", dispatchToken: "worker-secret", context: { deploy: { id: "0123456789abcdef01234567" }, site: { name: "library-vhs" } } };
  await assert.rejects(dispatchScanJob({ ...args, fetcher: async () => new Response("app shell", { status: 200 }) }), (error) => error.code === "SCAN_DISPATCH_FAILED");
  await dispatchScanJob({ ...args, fetcher: async (url, options) => {
    assert.equal(new URL(url).hostname, "0123456789abcdef01234567--library-vhs.netlify.app");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { jobId: "job-1", dispatchToken: "worker-secret" });
    assert.equal(Object.hasOwn(options.headers, "cookie"), false);
    return new Response(null, { status: 202 });
  } });
});

function mockStore() {
  let job = { id: "job-1", userId: "owner", mode: "fast", sourceId: "photo-1", status: "queued", stage: "queued" };
  const patches = [];
  return {
    patches,
    createJob: async () => ({ job, created: true, dispatchToken: "dispatch-secret" }),
    publicJob: (raw) => { const { userId, ...publicFields } = raw; return publicFields; },
    getJob: async ({ userId }) => userId === "owner" ? job : null,
    markDispatchFailed: async ({ error }) => { job = { ...job, dispatchError: error }; return job; },
    claimJob: async ({ dispatchToken }) => {
      if (dispatchToken !== "dispatch-secret" || job.status !== "queued") return null;
      job = { ...job, status: "running" };
      return { job, leaseToken: "lease-secret" };
    },
    getImage: async () => PHOTO,
    updateJob: async ({ patch }) => { patches.push(patch); job = { ...job, ...patch }; return job; },
    finishJob: async ({ patch }) => { patches.push(patch); job = { ...job, ...patch }; return job; },
  };
}

test("job creation dispatches only the job credential and returns no image or secret", async () => {
  const store = mockStore();
  let dispatchPayload;
  const handler = createScanJobsHandler({ authenticate: async () => ({ userId: "owner" }), store, dispatch: async ({ jobId, dispatchToken }) => { dispatchPayload = { jobId, dispatchToken }; } });
  const res = await handler(request({ image: PHOTO, clientId: "attempt-1" }));
  const body = await res.json();
  assert.equal(res.status, 202);
  assert.deepEqual(dispatchPayload, { jobId: "job-1", dispatchToken: "dispatch-secret" });
  assert.ok(JSON.stringify(dispatchPayload).length < 256);
  assert.equal(JSON.stringify(body).includes(PHOTO), false);
  assert.equal(JSON.stringify(body).includes("dispatch-secret"), false);
});

test("polling cannot read another account's job", async () => {
  const handler = createScanJobsHandler({ authenticate: async () => ({ userId: "other" }), store: mockStore() });
  const res = await handler(new Request("https://example.test/api/scan-jobs/job-1"));
  assert.equal(res.status, 404);
});

test("uncertain dispatch stays queued and retryable instead of claiming scan success", async () => {
  const handler = createScanJobsHandler({ authenticate: async () => ({ userId: "owner" }), store: mockStore(), dispatch: async () => { throw { name: "TimeoutError" }; } });
  const body = await (await handler(request({ image: PHOTO, clientId: "attempt-1" }))).json();
  assert.equal(body.job.status, "queued");
  assert.equal(body.dispatchError.retryable, true);
  assert.equal(body.dispatchError.code, "AI_TIMEOUT");
});

test("background invocation requires a one-time claim and duplicate calls do not infer twice", async (t) => {
  t.mock.method(console, "info", () => {});
  const store = mockStore();
  let calls = 0;
  const worker = createScanWorker({ store, processJob: async (body, options) => {
    calls++;
    assert.equal(body.image, PHOTO);
    await options.onProgress({ stage: "verifying", result: { tapes: [tape] } });
    return { tapes: [tape], needsVerification: true, verificationFailure: { code: "AI_TIMEOUT" } };
  } });
  assert.equal(workerConfig.background, true);
  await worker(request({ jobId: "job-1", dispatchToken: "wrong" }));
  assert.equal(calls, 0);
  await worker(request({ jobId: "job-1", dispatchToken: "dispatch-secret" }));
  await worker(request({ jobId: "job-1", dispatchToken: "dispatch-secret" }));
  assert.equal(calls, 1);
  assert.equal(store.patches.at(-1).status, "completed");
  assert.equal(store.patches.at(-1).result.tapes[0].title, "Alien");
});

function memoryBlobs() {
  const records = new Map();
  let version = 0;
  return {
    records,
    get: async (key) => structuredClone(records.get(key)?.data ?? null),
    getWithMetadata: async (key) => structuredClone(records.get(key) ?? null),
    getMetadata: async (key) => structuredClone(records.get(key) ?? null),
    setJSON: async (key, data, options = {}) => {
      const existing = records.get(key);
      if ((options.onlyIfNew && existing) || (options.onlyIfMatch && existing?.etag !== options.onlyIfMatch)) return;
      records.set(key, { data: structuredClone(data), metadata: options.metadata || {}, etag: String(++version) });
    },
    delete: async (key) => records.delete(key),
  };
}

test("real job store integrates create, background inference, owner polling and photo deletion", async (t) => {
  t.mock.method(console, "info", () => {});
  const jobs = memoryBlobs(), images = memoryBlobs();
  const store = createScanJobStore({ jobs, images });
  let invocation, calls = 0;
  const control = createScanJobsHandler({ authenticate: async () => ({ userId: "owner" }), store, dispatch: async ({ jobId, dispatchToken }) => { invocation = { jobId, dispatchToken }; } });
  const created = await (await control(request({ image: PHOTO, clientId: "stable-photo-attempt", sourceId: "photo-1" }))).json();
  assert.equal(created.job.status, "queued");
  const worker = createScanWorker({ store, processJob: (body, options) => processScanJob(body, {
    ...options, runStructured: async (input) => { calls++; return input.schema === COUNT_SCHEMA ? counted : reading; },
  }) });
  await worker(request(invocation), { requestId: "worker_request_123" });
  await worker(request(invocation));
  assert.equal(calls, 2);
  const polled = await (await control(new Request(`https://example.test/api/scan-jobs/${created.job.id}`))).json();
  assert.equal(polled.job.status, "completed");
  assert.equal(polled.job.result.tapes[0].title, "Alien");
  assert.equal(polled.job.result.requestId, "worker_request_123");
  assert.equal(polled.job.result.sourceId, "photo-1");
  assert.equal(images.records.size, 0);
  assert.equal(JSON.stringify(polled).includes(PHOTO), false);
  assert.equal(JSON.stringify(polled).includes(invocation.dispatchToken), false);
});
