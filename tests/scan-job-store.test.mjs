import test from "node:test";
import assert from "node:assert/strict";
import { createScanJobStore, publicJob, SCAN_JOB_IMAGE_TTL_MS, SCAN_JOB_RESULT_TTL_MS, SCAN_JOB_LEASE_MS } from "../netlify/lib/scan-job-store.mjs";
import { createScanJobsHandler } from "../netlify/functions/scan-jobs.mjs";
import { createScanWorker } from "../netlify/functions/scan-worker-background.mjs";

function mockStore({ phantom = false, loseResponse = false } = {}) {
  const records = new Map(); let version = 0;
  return {
    records, beforeSet: null, failDelete: false,
    async get(key) { return structuredClone(records.get(key)?.data ?? null); },
    async getWithMetadata(key) { return structuredClone(records.get(key) ?? null); },
    async getMetadata(key) { const found = records.get(key); return found ? { metadata: structuredClone(found.metadata), etag: found.etag } : null; },
    async list() { return { blobs: [...records.keys()].map((key) => ({ key })) }; },
    async setJSON(key, data, options = {}) {
      if (this.beforeSet) { const hook = this.beforeSet; this.beforeSet = null; await hook(key, data, options); }
      const current = records.get(key);
      if (options.onlyIfNew && current || options.onlyIfMatch && options.onlyIfMatch !== current?.etag) return { modified: true }; // Known SDK false-success behavior.
      if (!phantom) records.set(key, { data: structuredClone(data), metadata: structuredClone(options.metadata || {}), etag: String(++version) });
      if (loseResponse) throw new Error("Lost write acknowledgement");
      return { modified: true };
    },
    async delete(key) { if (this.failDelete) throw new Error("Delete unavailable"); records.delete(key); },
  };
}
const photo = (end = 0) => `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10,0,0,0,end]).toString("base64")}`;
const input = (extra = {}) => ({ userId: "owner", clientId: "photo-attempt-1", image: photo(), sourceId: "photo-1", ...extra });
const reading = { count: 1, reportedCount: 1, tapes: [{ title: "Alien", format: "VHS", marker: { x: 0.4, y: 0.5 } }], needsVerification: true, verification: { status: "mismatch" }, sourceId: "photo-1" };
function fixture(options = {}) {
  let stamp = Date.parse("2026-10-30T12:00:00.000Z");
  const jobs = mockStore(options), images = mockStore(options);
  const store = createScanJobStore({ jobs, images, now: () => stamp });
  return { store, jobs, images, advance: (ms) => { stamp += ms; } };
}
async function claimed(f) { const created = await f.store.createJob(input()); return { created, claim: await f.store.claimJob({ jobId: created.job.id, dispatchToken: created.dispatchToken }) }; }

test("private jobs isolate owners, hide credentials/images, and reject untrusted paths", async () => {
  const f = fixture(); const a = await f.store.createJob(input()), b = await f.store.createJob(input({ userId: "other" }));
  assert.notEqual(a.job.id, b.job.id); assert.equal(await f.store.getJob({ userId: "other", jobId: a.job.id }), null);
  const publicData = publicJob(a.job);
  for (const key of ["userId","dispatchHash","leaseHash","imageHash","creation","operations","image"]) assert.equal(Object.hasOwn(publicData, key), false);
  const raw = JSON.stringify([...f.jobs.records.values()]); assert.ok(!raw.includes(a.dispatchToken)); assert.ok(!raw.includes(photo()));
  assert.equal(await f.store.claimJob({ jobId: a.job.id, dispatchToken: "0".repeat(64) }), null);
  await assert.rejects(() => f.store.getJob({ userId: "owner", jobId: "../other" }), { status: 404 });
  await assert.rejects(() => f.store.createJob(input({ userId: "../other" })), { status: 400 });
});

test("lost create responses retry the same durable job, rotate queued dispatch, and reject changed inputs", async () => {
  const f = fixture({ loseResponse: true });
  const first = await f.store.createJob(input()), retry = await f.store.createJob(input());
  assert.equal(first.created, true); assert.equal(retry.created, false); assert.equal(first.job.id, retry.job.id); assert.notEqual(first.dispatchToken, retry.dispatchToken);
  assert.equal(f.jobs.records.size, 1); assert.equal(f.images.records.size, 1);
  assert.equal(await f.store.claimJob({ jobId: first.job.id, dispatchToken: first.dispatchToken }), null);
  assert.ok(await f.store.claimJob({ jobId: retry.job.id, dispatchToken: retry.dispatchToken }));
  await assert.rejects(() => f.store.createJob(input({ image: photo(1) })), { status: 409, code: "JOB_INPUT_CONFLICT" });
  await assert.rejects(() => f.store.createJob(input({ mode: "thorough" })), { status: 409 });
});

test("concurrent creates/dispatch retries claim exactly one worker", async () => {
  const f = fixture();
  const copies = await Promise.all(Array.from({ length: 4 }, () => f.store.createJob(input())));
  assert.equal(new Set(copies.map((item) => item.job.id)).size, 1);
  const current = (await f.jobs.get(copies[0].job.id));
  const usable = copies.filter((entry) => entry.dispatchToken);
  const claims = await Promise.all(usable.flatMap((entry) => [entry,entry]).map((entry) => f.store.claimJob({ jobId: current.id, dispatchToken: entry.dispatchToken })));
  assert.equal(claims.filter(Boolean).length, 1);
  const retry = await f.store.createJob(input()); assert.equal(retry.dispatchToken, null); assert.equal(retry.job.status, "running");
});

test("worker lease gates image access, progress and terminal updates", async () => {
  const f = fixture(); const { created, claim } = await claimed(f);
  const args = { jobId: created.job.id, leaseToken: claim.leaseToken };
  assert.equal(await f.store.getImage(args), photo());
  assert.ok(!JSON.stringify([...f.jobs.records.values()]).includes(claim.leaseToken));
  await assert.rejects(() => f.store.getImage({ ...args, leaseToken: "0".repeat(64) }), { status: 409 });
  const next = await f.store.updateJob({ ...args, patch: { stage: "verifying", result: reading, progress: { independentCount: 2, countFinished: true }, userId: "intruder" } });
  assert.equal(next.userId, "owner"); assert.equal(next.result.tapes[0].title, "Alien"); assert.deepEqual(publicJob(next).progress, { independentCount: 2, countFinished: true });
  const done = await f.store.finishJob({ ...args, patch: { status: "completed", result: reading } });
  assert.equal(done.status, "completed"); assert.equal(f.images.records.size, 0);
  assert.equal(await f.store.claimJob({ jobId: created.job.id, dispatchToken: created.dispatchToken }), null);
  await assert.rejects(() => f.store.updateJob({ ...args, patch: { stage: "reading" } }), { status: 409 });
  assert.equal((await f.store.createJob(input())).job.status, "completed"); assert.equal(f.images.records.size, 0);
});

test("verification failure keeps the first result and deletes temporary photos", async () => {
  const f = fixture(); const { created, claim } = await claimed(f);
  const args = { jobId: created.job.id, leaseToken: claim.leaseToken };
  await f.store.updateJob({ ...args, patch: { stage: "verifying", result: reading } });
  const failed = await f.store.finishJob({ ...args, patch: { status: "failed", error: { code: "AI_TIMEOUT", message: "Verification timed out", retryable: true } } });
  assert.equal(failed.status, "completed"); assert.deepEqual(failed.result, reading); assert.equal(failed.error, null); assert.equal(failed.verificationFailure.code, "AI_TIMEOUT"); assert.equal(f.images.records.size, 0);
});

test("expired worker lease is never reclaimed; initial readings survive and a fresh attempt can retry", async () => {
  const f = fixture(); const { created, claim } = await claimed(f);
  await f.store.updateJob({ jobId: created.job.id, leaseToken: claim.leaseToken, patch: { stage: "verifying", result: reading } });
  f.advance(SCAN_JOB_LEASE_MS + 1);
  const expired = await f.store.getJob({ userId: "owner", jobId: created.job.id });
  assert.equal(expired.status, "completed"); assert.equal(expired.verificationFailure.code, "WORKER_INTERRUPTED"); assert.deepEqual(expired.result, reading);
  assert.equal(await f.store.claimJob({ jobId: created.job.id, dispatchToken: created.dispatchToken }), null);
  await assert.rejects(() => f.store.finishJob({ jobId: created.job.id, leaseToken: claim.leaseToken, patch: { status: "completed", result: reading } }), { status: 409 });
  const retried = await f.store.createJob(input({ clientId: "photo-attempt-2" })); assert.notEqual(retried.job.id, created.job.id); assert.ok(retried.dispatchToken);
  const other = fixture(); const run = await claimed(other); other.advance(SCAN_JOB_LEASE_MS + 1);
  assert.equal((await other.store.getJob({ userId: "owner", jobId: run.created.job.id })).status, "failed");
});

test("queued photo expiry and result retention preserve tombstones without restarting old jobs", async () => {
  const f = fixture(); const created = await f.store.createJob(input()); f.advance(SCAN_JOB_IMAGE_TTL_MS + 1);
  assert.equal((await f.store.getJob({ userId: "owner", jobId: created.job.id })).status, "expired"); assert.equal(f.images.records.size, 0);
  assert.equal((await f.store.createJob(input())).dispatchToken, null); assert.equal(f.images.records.size, 0);
  const other = fixture(); const run = await claimed(other);
  await other.store.finishJob({ jobId: run.created.job.id, leaseToken: run.claim.leaseToken, patch: { status: "completed", result: reading } });
  other.advance(SCAN_JOB_RESULT_TTL_MS + 1);
  const expired = await other.store.getJob({ userId: "owner", jobId: run.created.job.id });
  assert.equal(expired.status, "expired"); assert.equal(expired.result, null); assert.equal(expired.dispatchHash, undefined);
  assert.equal((await other.store.createJob(input())).dispatchToken, null);
});

test("failed dispatch remains recoverable and stale dispatch failures cannot alter a running job", async () => {
  const f = fixture(); const created = await f.store.createJob(input());
  const marked = await f.store.markDispatchFailed({ jobId: created.job.id, dispatchToken: created.dispatchToken, error: { code: "DISPATCH_TIMEOUT", message: "Saved, waiting to start", retryable: true, secret: "hidden" } });
  assert.equal(marked.status, "queued"); assert.equal(marked.dispatchError.code, "DISPATCH_TIMEOUT"); assert.equal(marked.dispatchError.secret, undefined);
  const retried = await f.store.createJob(input()); assert.equal(retried.job.dispatchError, null);
  await f.store.claimJob({ jobId: created.job.id, dispatchToken: retried.dispatchToken });
  assert.equal((await f.store.markDispatchFailed({ jobId: created.job.id, dispatchToken: retried.dispatchToken, error: { message: "late" } })).dispatchError, null);
});

test("terminal errors retain safe diagnostics and cooldowns without provider bodies or credentials", async () => {
  const f = fixture(); const { created, claim } = await claimed(f);
  const job = await f.store.finishJob({ jobId: created.job.id, leaseToken: claim.leaseToken, patch: { status: "failed", error: {
    error: "The provider is busy", code: "AI_RATE_LIMITED", status: 429, retryable: true, retryAfterMs: 9000, requestId: "safe-request_123",
    errorDetails: { stage: "identification", durationMs: 3000, providerStatus: 429, providerType: "rate_limit_error", providerRequestId: "req_123", body: "PRIVATE", image: photo(), authorization: "PRIVATE" },
    token: "PRIVATE", rawResponse: "PRIVATE",
  } } });
  assert.deepEqual(publicJob(job).error, { code: "AI_RATE_LIMITED", message: "The provider is busy", retryable: true, status: 429, retryAfterMs: 9000, requestId: "safe-request_123", errorDetails: { providerStatus: 429, providerType: "rate_limit_error", providerRequestId: "req_123", stage: "identification", durationMs: 3000 } });
  assert.ok(!JSON.stringify(publicJob(job)).includes("PRIVATE")); assert.ok(!JSON.stringify(publicJob(job)).includes(photo()));
});

test("false SDK acknowledgements never confirm unstored photos or jobs", async () => {
  const f = fixture({ phantom: true });
  await assert.rejects(() => f.store.createJob(input()), { status: 503 }); assert.equal(f.jobs.records.size, 0);
  const jobs = mockStore({ phantom: true }), images = mockStore();
  const store = createScanJobStore({ jobs, images });
  await assert.rejects(() => store.createJob(input()), { status: 503 }); assert.equal(jobs.records.size, 0); assert.equal(images.records.size, 1, "orphan upload remains only until expiry cleanup");
});

test("bounded cleanup advances past live jobs, retries failed deletes and removes orphan uploads", async () => {
  const f = fixture();
  for (let n = 0; n < 4; n++) await f.store.createJob(input({ clientId: `photo-${n}` }));
  const orphanId = `j_${"f".repeat(64)}`;
  await f.images.setJSON(orphanId, { image: photo() }, { metadata: { expiresAt: new Date(0).toISOString() } });
  f.advance(SCAN_JOB_IMAGE_TTL_MS + 1); f.images.failDelete = true;
  await f.store.cleanupExpiredJobs({ limit: 2 }); assert.equal(f.images.records.size, 5);
  f.images.failDelete = false;
  for (let n = 0; n < 4; n++) { const result = await f.store.cleanupExpiredJobs({ limit: 2 }); assert.ok(result.jobsScanned <= 2); assert.ok(result.imagesScanned <= 2); }
  assert.equal(f.images.records.size, 0);
  for (const [key, stored] of f.jobs.records) if (key !== "_cleanup") assert.equal(stored.data.status, "expired");
});

test("authenticated control routes and the background worker use the real store contract end to end", async () => {
  const f = fixture(); let paidWork = 0;
  const worker = createScanWorker({ store: f.store, processJob: async (_body, options) => {
    paidWork++; await options.onProgress({ stage: "verifying", result: reading });
    return { ...reading, needsVerification: false };
  } });
  const handler = createScanJobsHandler({ store: f.store, authenticate: async (req) => req.headers.get("test-owner") ? { userId: req.headers.get("test-owner") } : null,
    dispatch: async ({ jobId, dispatchToken }) => {
      const request = () => new Request("https://vault.test/.netlify/functions/scan-worker-background", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, dispatchToken }) });
      await Promise.all([worker(request()), worker(request())]);
    },
  });
  const post = (owner = "owner", extra = {}) => new Request("https://vault.test/api/scan-jobs", { method: "POST", headers: { "content-type": "application/json", "test-owner": owner }, body: JSON.stringify({ clientId: "integration-photo", image: photo(), ...extra }) });
  const first = await handler(post()); assert.equal(first.status, 202); const body = await first.json();
  assert.equal((await handler(post())).status, 202); assert.equal(paidWork, 1);
  const get = (owner) => handler(new Request(`https://vault.test/api/scan-jobs/${body.job.id}`, { headers: { "test-owner": owner } }));
  assert.equal((await get("other")).status, 404);
  const returned = await (await get("owner")).json(); assert.equal(returned.job.status, "completed"); assert.equal(returned.job.result.tapes[0].title, "Alien");
  assert.equal(returned.job.dispatchHash, undefined); assert.equal(returned.job.leaseHash, undefined); assert.equal(f.images.records.size, 0);
  assert.equal((await handler(post("owner", { image: photo(1) }))).status, 409);
  assert.equal((await handler(post(""))).status, 401);
});
