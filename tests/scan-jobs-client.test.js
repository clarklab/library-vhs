import test from "node:test";
import assert from "node:assert/strict";
import { ScanSession, requiresPhotoReview } from "../public/js/scan-session.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail("Background state did not settle"); }
const result = (title = "Alien", patch = {}) => ({ tapes: [{ title, format: "VHS", confidence: "high", marker: { x: .5, y: .5 } }], verification: { status: "matched", countedCount: 1, listedCount: 1, uncertainCount: 0 }, ...patch });
const job = (status, extra = {}) => ({ job: { id: "job-one", status, stage: status === "running" ? "reading" : status, createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), deadlineAt: new Date(481000).toISOString(), ...extra }, pollAfterMs: 1500 });
function fixture(client, { saved = null, wait = async () => {}, storage, now = () => 1000 } = {}) {
  let counter = 0;
  const writes = [];
  const session = new ScanSession("account-one", saved, { client, expectedToken: "pinned-account", id: () => `stable-${++counter}`, now, wait, storage: storage || { put: async (value) => writes.push(structuredClone(value)) } });
  if (!saved) session.draft.photos = [{ id: "photo-one", name: "Shelf.jpg", image: "data:image/jpeg;base64,photo", status: "queued" }];
  return { session, writes };
}

test("production-default jobs persist the create key, report stages, and never run a second browser verifier", async () => {
  let polls = 0, creates = 0;
  const stages = [];
  const { session, writes } = fixture({
    createScanJob: async (payload, options) => {
      creates++; assert.equal(payload.clientId, writes.at(-1).photos[0].jobClientId); assert.equal(options.expectedToken, "pinned-account");
      return job("queued");
    },
    getScanJob: async (id, options) => {
      assert.equal(id, "job-one"); assert.equal(options.expectedToken, "pinned-account");
      if (++polls === 1) return job("running", { progress: { independentCount: 24, countFinished: true } });
      if (polls === 2) return job("running", { stage: "verifying", result: result("First reading", { needsVerification: true }) });
      return job("completed", { result: result("Final title", { needsVerification: true }) });
    },
    scanPhoto: async () => assert.fail("The worker owns verification; no direct API inference is allowed"),
  });
  session.subscribe(() => stages.push(session.draft.photos[0].stage));
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(creates, 1); assert.equal(polls, 3);
  assert.equal(stages.includes("reading"), true); assert.equal(stages.includes("verifying"), true);
  assert.equal(writes.some((draft) => draft.photos[0].initialResult?.tapes[0].title === "First reading"), true);
  assert.deepEqual(session.draft.photos[0].jobProgress, { independentCount: 24, countFinished: true });
  assert.equal(session.draft.items[0].title, "Final title"); assert.equal(session.draft.photos[0].background, true); session.dispose();
});

test("pause and reload stop polling but resume the same persisted background job", async () => {
  let waiting = false, creates = 0;
  const { session } = fixture({ createScanJob: async () => { creates++; return job("running", { stage: "verifying", result: result("Already read") }); } }, {
    wait: (_ms, signal) => { waiting = true; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")))); },
  });
  session.resume(); await until(() => waiting); session.pause(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].status, "queued"); assert.equal(session.draft.photos[0].stage, "paused");
  assert.equal(session.draft.photos[0].error, "");
  const saved = structuredClone(session.draft); session.dispose();
  const recovered = fixture({
    createScanJob: async () => assert.fail("Reload must not create another job"),
    getScanJob: async (id) => { assert.equal(id, "job-one"); return job("completed", { startedAt: new Date(1500).toISOString(), result: result("Completed while away") }); },
  }, { saved }).session;
  recovered.resume(); await until(() => recovered.controllers.size === 0);
  assert.equal(creates, 1); assert.equal(recovered.draft.items[0].title, "Completed while away"); assert.equal(recovered.draft.photos[0].startedAt, 1500); recovered.dispose();
});

test("a lost create response reuses its durable client ID instead of paying for another scan", async () => {
  const keys = [];
  const { session } = fixture({ createScanJob: async ({ clientId }) => {
    keys.push(clientId);
    if (keys.length === 1) throw Object.assign(new Error("Connection interrupted"), { status: 0, retryable: true, code: "NETWORK_ERROR" });
    return job("completed", { result: result() });
  } });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].status, "error"); assert.equal(session.retryPhoto("photo-one"), true);
  await until(() => session.controllers.size === 0);
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(session.draft.items.length, 1); session.dispose();
});

test("poll transport failures retry the existing running job", async () => {
  let creates = 0, polls = 0;
  const { session } = fixture({
    createScanJob: async () => { creates++; return job("running"); },
    getScanJob: async () => { if (++polls === 1) throw Object.assign(new Error("Polling connection lost"), { status: 0, retryable: true }); return job("completed", { result: result() }); },
  });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].jobId, "job-one"); session.retryPhoto("photo-one"); await until(() => session.controllers.size === 0);
  assert.equal(creates, 1); assert.equal(polls, 2); assert.equal(session.draft.items.length, 1); session.dispose();
});

test("only an explicit retry of a terminal failed job allocates a new inference key", async () => {
  const keys = [];
  const { session } = fixture({ createScanJob: async ({ clientId }) => {
    keys.push(clientId);
    return keys.length === 1 ? job("failed", { error: { message: "Worker timed out", code: "AI_TIMEOUT", retryable: true } }) : job("completed", { result: result() });
  } });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(keys.length, 1); assert.equal(session.draft.photos[0].errorCode, "AI_TIMEOUT");
  session.retryPhoto("photo-one"); await until(() => session.controllers.size === 0);
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]); assert.equal(session.draft.items.length, 1); session.dispose();
});

test("background scans cannot start before their idempotency key is durably saved", async () => {
  const { session } = fixture({ createScanJob: async () => assert.fail("No scan may start without a durable job key") }, { storage: { put: async () => { throw new Error("Quota exceeded"); } } });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].errorCode, "DRAFT_STORAGE_UNAVAILABLE"); assert.equal(session.draft.paused, true); session.dispose();
});

test("a background verifier failure retains usable titles with diagnostics and a review gate", async () => {
  const { session } = fixture({ createScanJob: async () => job("completed", {
    result: result("Retained title"), verificationFailure: { message: "Closer reading timed out", code: "AI_TIMEOUT", retryable: true, requestId: "verifier-id", errorDetails: { stage: "identification", durationMs: 38000 } },
  }) });
  session.resume(); await until(() => session.controllers.size === 0);
  const photo = session.draft.photos[0];
  assert.equal(photo.status, "complete"); assert.equal(requiresPhotoReview(photo), true);
  assert.equal(photo.verificationFailure.requestId, "verifier-id"); assert.equal(photo.verificationFailure.errorDiagnostics.durationMs, 38000);
  assert.equal(session.draft.items[0].title, "Retained title"); session.dispose();
});

test("a stuck queued dispatch is nudged once with the same key and then waits for an explicit retry", async () => {
  let now = 1000, creates = 0, polls = 0; const keys = [];
  const { session } = fixture({
    createScanJob: async ({ clientId }) => { creates++; keys.push(clientId); return job("queued"); },
    getScanJob: async () => { polls++; return job("queued"); },
  }, { now: () => now, wait: async () => { now += 30000; } });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(creates, 2); assert.equal(new Set(keys).size, 1); assert.equal(polls, 2);
  assert.equal(session.draft.photos[0].errorCode, "SCAN_JOB_QUEUED"); assert.equal(session.draft.photos[0].jobId, "job-one"); session.dispose();
});

test("an explicit redispatch gives an old queued job time to start while retaining its original key", async () => {
  let polls = 0, creates = 0;
  const { session } = fixture({
    createScanJob: async (payload) => { creates++; assert.equal(payload.clientId, "old-key"); return job("queued"); },
    getScanJob: async () => { polls++; return job("completed", { result: result() }); },
  }, { now: () => 120000 });
  Object.assign(session.draft.photos[0], { status: "error", jobId: "job-one", jobClientId: "old-key", jobStatus: "queued", jobCreatedAt: 1000, jobDispatchRetried: true, retryable: true });
  assert.equal(session.retryPhoto("photo-one"), true); await until(() => session.controllers.size === 0);
  assert.equal(creates, 1); assert.equal(polls, 1); assert.equal(session.draft.photos[0].status, "complete"); session.dispose();
});

test("a job removed after retention can explicitly restart instead of polling a missing ID forever", async () => {
  let polls = 0, creates = 0;
  const { session } = fixture({
    getScanJob: async () => { polls++; throw Object.assign(new Error("Scan not found"), { code: "SCAN_JOB_NOT_FOUND", status: 404, retryable: false }); },
    createScanJob: async (payload) => { creates++; assert.notEqual(payload.clientId, "expired-key"); return job("completed", { result: result() }); },
  });
  Object.assign(session.draft.photos[0], { jobId: "old-job", jobClientId: "expired-key", jobStatus: "running" });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].jobStatus, "expired"); assert.equal(session.draft.photos[0].retryable, true);
  assert.equal(session.retryPhoto("photo-one"), true); await until(() => session.controllers.size === 0);
  assert.equal(polls, 1); assert.equal(creates, 1); assert.equal(session.draft.photos[0].status, "complete"); session.dispose();
});

test("a cached reading from the old direct scanner migrates to review without paid work", async () => {
  const { session } = fixture({
    createScanJob: async () => assert.fail("An existing paid first reading must be recovered"),
    scanPhoto: async () => assert.fail("Migration must not start a direct verifier"),
  });
  Object.assign(session.draft.photos[0], { initialResult: result("Older draft title", { needsVerification: true }), initialMode: "fast", verificationAttempted: true });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.items[0].title, "Older draft title"); assert.equal(requiresPhotoReview(session.draft.photos[0]), true);
  assert.match(session.draft.photos[0].verificationError, /saved first reading was recovered/); session.dispose();
});

test("an expired server result still recovers the locally retained first reading", async () => {
  const { session } = fixture({
    createScanJob: async () => assert.fail("A saved job should only be polled"),
    getScanJob: async () => job("expired", { result: null, error: { message: "This result expired", code: "JOB_EXPIRED", retryable: true } }),
  });
  Object.assign(session.draft.photos[0], { jobId: "job-one", jobClientId: "saved-key", jobStatus: "running", initialResult: result("Locally retained title") });
  session.resume(); await until(() => session.controllers.size === 0);
  assert.equal(session.draft.photos[0].status, "complete"); assert.equal(session.draft.items[0].title, "Locally retained title");
  assert.equal(requiresPhotoReview(session.draft.photos[0]), true); session.dispose();
});

test("background submission remains bounded at two photos and ignores results after an account change", async () => {
  const requests = [];
  const { session } = fixture({ createScanJob: async (payload) => new Promise((resolve) => requests.push({ payload, resolve })) });
  session.draft.photos.push(...["two", "three"].map((name) => ({ id: `photo-${name}`, image: "photo", status: "queued" })));
  session.resume(); await until(() => requests.length === 2);
  assert.equal(session.controllers.size, 2);
  requests[0].resolve(job("completed", { result: result("First") })); await until(() => requests.length === 3);
  assert.equal(session.draft.items.length, 1); assert.equal(session.controllers.size, 2);
  requests[1].resolve(job("completed", { result: result("Second") })); requests[2].resolve(job("completed", { result: result("Third") }));
  await until(() => session.controllers.size === 0); assert.equal(session.draft.items.length, 3); session.dispose();

  const originalStorage = globalThis.localStorage;
  let token = "pinned-account", resolve;
  globalThis.localStorage = { getItem: () => token };
  try {
    const late = fixture({
      createScanJob: async (_payload, options) => { assert.equal(options.expectedToken, "pinned-account"); return new Promise((done) => { resolve = done; }); },
      getScanJob: async () => assert.fail("Changed accounts must not continue polling private jobs"),
    }).session;
    late.resume(); await until(() => Boolean(resolve)); token = "another-account";
    resolve(job("completed", { result: result("Private prior-account result") })); await until(() => late.controllers.size === 0);
    assert.equal(late.draft.items.length, 0); assert.equal(late.draft.photos[0].jobId, undefined); late.dispose();
  } finally { globalThis.localStorage = originalStorage; }
});
