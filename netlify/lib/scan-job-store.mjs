import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { parseImageDataUrl } from "./scan-contract.mjs";
import { mapWithConcurrency } from "./tape-batch.mjs";
import { safeAiDiagnostics, safeRequestId } from "./ai.mjs";

export const SCAN_JOB_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCAN_JOB_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SCAN_JOB_WORKER_BUDGET_MS = 8 * 60 * 1000;
export const SCAN_JOB_LEASE_MS = 10 * 60 * 1000;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_ID = /^j_[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(["completed", "failed", "expired"]);
const STAGES = new Set(["queued", "reading", "counting", "verifying", "completed", "failed", "expired"]);
const RESULT_FIELDS = ["count", "reportedCount", "tapes", "notes", "warnings", "reviewCount", "coverage", "needsVerification", "verification", "verificationFailure", "sourceId", "model", "mode", "durationMs", "requestId", "countError"];
const PUBLIC_FIELDS = ["id", "clientId", "sourceId", "mode", "status", "stage", "createdAt", "updatedAt", "startedAt", "completedAt", "expiresAt", "imageExpiresAt", "deadlineAt", "leaseExpiresAt", "result", "error", "verificationFailure", "dispatchError", "progress"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const iso = (time) => new Date(time).toISOString();
const time = (value) => Date.parse(value || "");

export class ScanJobError extends Error {
  constructor(message, status = 400, code = "INVALID_SCAN_JOB", retryable = false) {
    super(message); this.name = "ScanJobError"; this.status = status; this.code = code;
    this.retryable = retryable; this.retryAfterMs = retryable ? 1500 : 0; this.friendly = true;
  }
}
const fail = (message, status, code, retryable) => { throw new ScanJobError(message, status, code, retryable); };
const validId = (value, label) => { if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`Invalid ${label}.`, 400); return value; };
const validJobId = (value) => { if (typeof value !== "string" || !JOB_ID.test(value)) fail("Scan job not found.", 404, "JOB_NOT_FOUND"); return value; };
const matchesToken = (value, hash) => TOKEN.test(value || "") && TOKEN.test(hash || "") && timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"));
const cleanError = (value) => {
  if (value == null) return null;
  const requestId = safeRequestId(value.requestId);
  const detail = value.errorDetails || {};
  const errorDetails = safeAiDiagnostics({ friendly: true, diagnostics: detail }, {
    stage: detail.stage,
    durationMs: typeof detail.durationMs === "number" ? Math.min(86400000, detail.durationMs) : undefined,
  });
  return {
    code: typeof value.code === "string" ? value.code.slice(0, 80) : "SCAN_JOB_FAILED",
    message: typeof value.message === "string" ? value.message.slice(0, 600) : typeof value.error === "string" ? value.error.slice(0, 600) : "This scan could not finish. Retry this photo.",
    retryable: value.retryable === true,
    ...(Number.isInteger(value.status) && value.status >= 0 && value.status <= 599 ? { status: value.status } : {}),
    ...(Number.isFinite(value.retryAfterMs) ? { retryAfterMs: Math.max(0, Math.min(3600000, Math.ceil(value.retryAfterMs))) } : {}),
    ...(requestId ? { requestId } : {}),
    ...(Object.keys(errorDetails).length ? { errorDetails } : {}),
  };
};

function cleanResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.tapes) || value.tapes.length > 100) fail("The scan job returned invalid results.", 502, "INVALID_JOB_RESULT");
  const result = Object.fromEntries(RESULT_FIELDS.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  const encoded = JSON.stringify(result, (key, entry) => {
    if (/^(?:image|photo|base64|dataUrl|dispatchToken|leaseToken|token|authorization|password|passHash|recoveryHash)$/i.test(key)) return undefined;
    return entry;
  });
  if (Buffer.byteLength(encoded) > 1024 * 1024) fail("The scan results are too large to save safely.", 502, "INVALID_JOB_RESULT");
  return JSON.parse(encoded);
}

/** A public snapshot never includes the image, owner ID, secret hashes or lease credential. */
export function publicJob(job) {
  if (!job) return null;
  return structuredClone(Object.fromEntries(PUBLIC_FIELDS.filter((key) => Object.hasOwn(job, key)).map((key) => [key, job[key]])));
}

/** Injected stores let tests exercise races without contacting production. */
export function createScanJobStore({ jobs = getStore({ name: "scan-jobs", consistency: "strong" }), images = getStore({ name: "scan-job-images", consistency: "strong" }), now = Date.now } = {}) {
  const read = (id) => jobs.getWithMetadata(id, { type: "json", consistency: "strong" });
  const imageMetadata = async (id) => typeof images.getMetadata === "function"
    ? images.getMetadata(id, { consistency: "strong" })
    : images.getWithMetadata(id, { type: "json", consistency: "strong" });

  async function mutate(id, change) {
    const operation = randomUUID();
    for (let attempt = 0; attempt < 6; attempt++) {
      const stored = await read(id);
      if (stored && !stored.etag) fail("This scan could not be updated safely. Retry shortly.", 503, "JOB_STORAGE_UNAVAILABLE", true);
      const current = stored?.data || null;
      const next = await change(current);
      if (next === current || next === null) return current;
      next.updatedAt = iso(now());
      next.operations = [...(current?.operations || []).slice(-11), operation];
      let writeError;
      try { await jobs.setJSON(id, next, stored ? { onlyIfMatch: stored.etag } : { onlyIfNew: true }); } catch (error) { writeError = error; }
      const confirmed = await read(id);
      if (confirmed?.data?.operations?.includes(operation)) return confirmed.data;
      if (writeError && !confirmed) fail("This scan could not be confirmed as saved. Retry with the same photo.", 503, "JOB_STORAGE_UNAVAILABLE", true);
    }
    fail("This scan changed while saving. Retry shortly.", 503, "JOB_STORAGE_CONFLICT", true);
  }

  async function removeImage(id) {
    try { await images.delete(id); return true; } catch { return false; } // Hourly cleanup retries deletion.
  }

  async function expire(id) {
    const job = await mutate(id, (current) => {
      if (!current) return null;
      const stamp = now();
      if (time(current.expiresAt) <= stamp) {
        if (current.status === "expired" && current.result === null && !current.dispatchHash && !current.leaseHash) return current;
        // Keep a small idempotency tombstone: an ancient POST must not restart paid work.
        return { id: current.id, userId: current.userId, clientId: current.clientId, sourceId: current.sourceId, mode: current.mode,
          createdAt: current.createdAt, expiresAt: current.expiresAt, imageExpiresAt: current.imageExpiresAt,
          status: "expired", stage: "expired", result: null, error: { code: "JOB_EXPIRED", message: "This scan result has expired. Start a new attempt from your saved photo.", retryable: true } };
      }
      if (current.status === "running" && time(current.leaseExpiresAt) <= stamp) {
        const error = { code: "WORKER_INTERRUPTED", message: "This scan stopped before finishing. Your first reading is kept when available.", retryable: true };
        return { ...current, status: current.result ? "completed" : "failed", stage: current.result ? "completed" : "failed",
          completedAt: iso(stamp), error: current.result ? null : error, verificationFailure: current.result ? error : current.verificationFailure,
          leaseHash: null, dispatchHash: null };
      }
      if (current.status === "queued" && time(current.imageExpiresAt) <= stamp) {
        return { ...current, status: "expired", stage: "expired", result: null, completedAt: iso(stamp), dispatchHash: null,
          error: { code: "JOB_EXPIRED", message: "The temporary photo has expired. Start a new attempt from your saved photo.", retryable: true } };
      }
      return current;
    });
    if (job && TERMINAL.has(job.status)) await removeImage(id);
    return job;
  }

  async function createJob({ userId, clientId, image, mode = "fast", sourceId = null }) {
    validId(userId, "account"); validId(clientId, "photo attempt ID");
    if (!["fast", "thorough"].includes(mode)) fail("Choose Fast or Thorough scanning.", 400, "INVALID_SCAN_MODE");
    if (!parseImageDataUrl(image)) fail("Choose a valid JPEG, PNG or WebP photo.", 400, "INVALID_IMAGE");
    const id = `j_${digest(JSON.stringify([userId, clientId]))}`;
    const imageHash = digest(image), dispatchToken = token(), dispatchHash = digest(dispatchToken), creation = randomUUID();
    const current = (await read(id))?.data;
    if (current) await expire(id);
    let imageExpiresAt = iso(now() + SCAN_JOB_IMAGE_TTL_MS);
    if (!current) {
      let imageWriteError;
      try { await images.setJSON(id, { image }, { onlyIfNew: true, metadata: { userId, imageHash, expiresAt: imageExpiresAt } }); } catch (error) { imageWriteError = error; }
      const storedImage = await imageMetadata(id);
      if (!storedImage || storedImage.metadata?.userId !== userId || storedImage.metadata?.imageHash !== imageHash) {
        if (storedImage) fail("This photo attempt already belongs to a different image. Start a new attempt.", 409, "JOB_INPUT_CONFLICT");
        fail(imageWriteError ? "The photo upload could not be confirmed. Retry this same photo." : "The photo was not saved. Retry this same photo.", 503, "JOB_STORAGE_UNAVAILABLE", true);
      }
      imageExpiresAt = storedImage.metadata.expiresAt;
      if (!Number.isFinite(time(imageExpiresAt)) || time(imageExpiresAt) <= now()) fail("This photo attempt has expired. Start a new attempt.", 410, "JOB_EXPIRED", true);
    }
    const job = await mutate(id, (saved) => {
      if (saved) {
        if (saved.userId !== userId || saved.clientId !== clientId) fail("Scan job not found.", 404, "JOB_NOT_FOUND");
        if (saved.status === "expired") return saved;
        if (saved.imageHash !== imageHash || saved.mode !== mode) fail("This attempt already belongs to a different photo or scan mode. Start a new attempt.", 409, "JOB_INPUT_CONFLICT");
        return saved.status === "queued" ? { ...saved, dispatchHash, dispatchError: null } : saved;
      }
      const createdAt = iso(now());
      return { id, userId, clientId, sourceId: typeof sourceId === "string" ? sourceId.slice(0, 120) : null, mode, imageHash,
        createdAt, expiresAt: iso(now() + SCAN_JOB_RESULT_TTL_MS), imageExpiresAt,
        status: "queued", stage: "queued", result: null, error: null, verificationFailure: null, dispatchError: null,
        progress: { independentCount: null, countFinished: false }, dispatchHash, leaseHash: null, creation };
    });
    if (TERMINAL.has(job.status)) await removeImage(id);
    return { job, created: job.creation === creation, dispatchToken: job.status === "queued" && job.dispatchHash === dispatchHash ? dispatchToken : null };
  }

  async function getJob({ userId, jobId }) {
    validId(userId, "account"); validJobId(jobId);
    const current = (await read(jobId))?.data;
    if (!current || current.userId !== userId) return null;
    return expire(jobId);
  }

  async function claimJob({ jobId, dispatchToken }) {
    validJobId(jobId);
    const existing = (await read(jobId))?.data;
    if (!existing || !matchesToken(dispatchToken, existing.dispatchHash)) return null;
    const fresh = await expire(jobId);
    if (TERMINAL.has(fresh.status)) return null;
    const leaseToken = token(), leaseHash = digest(leaseToken);
    const job = await mutate(jobId, (current) => {
      if (!current || !matchesToken(dispatchToken, current.dispatchHash)) return current;
      if (current.status !== "queued") return current;
      return { ...current, status: "running", stage: "reading", dispatchError: null, leaseHash,
        startedAt: iso(now()), deadlineAt: iso(now() + SCAN_JOB_WORKER_BUDGET_MS), leaseExpiresAt: iso(now() + SCAN_JOB_LEASE_MS) };
    });
    return job?.status === "running" && job.leaseHash === leaseHash ? { job, leaseToken } : null;
  }

  function assertLease(job, leaseToken) {
    if (!job || job.status !== "running" || !matchesToken(leaseToken, job.leaseHash) || time(job.leaseExpiresAt) <= now()) fail("This scan worker no longer owns the job.", 409, "JOB_LEASE_EXPIRED");
  }

  async function getImage({ jobId, leaseToken }) {
    validJobId(jobId);
    const job = await expire(jobId); assertLease(job, leaseToken);
    const stored = await images.getWithMetadata(jobId, { type: "json", consistency: "strong" });
    if (!stored?.data?.image || stored.metadata?.userId !== job.userId || stored.metadata?.imageHash !== job.imageHash || !Number.isFinite(time(stored.metadata?.expiresAt)) || time(stored.metadata.expiresAt) <= now()) fail("The temporary photo is unavailable. Retry from your saved photo.", 410, "JOB_IMAGE_EXPIRED", true);
    return stored.data.image;
  }

  function patchJob(current, patch = {}, terminal = false) {
    const next = { ...current };
    if (patch.stage !== undefined) {
      if (!STAGES.has(patch.stage) || (!terminal && TERMINAL.has(patch.stage))) fail("Invalid scan progress stage.", 400);
      next.stage = patch.stage;
    }
    if (patch.result !== undefined && patch.result !== null) next.result = cleanResult(patch.result);
    for (const key of ["error", "verificationFailure"]) if (Object.hasOwn(patch, key)) next[key] = cleanError(patch[key]);
    if (patch.progress !== undefined) {
      const value = patch.progress;
      if (!value || typeof value.countFinished !== "boolean" || (value.independentCount !== null && (!Number.isInteger(value.independentCount) || value.independentCount < 0 || value.independentCount > 10000))) fail("Invalid scan count progress.", 400);
      next.progress = { independentCount: value.independentCount, countFinished: value.countFinished };
    }
    return next;
  }

  async function updateJob({ jobId, leaseToken, patch }) {
    validJobId(jobId);
    return mutate(jobId, (job) => { assertLease(job, leaseToken); return patchJob(job, patch); });
  }

  async function finishJob({ jobId, leaseToken, patch = {} }) {
    validJobId(jobId);
    const job = await mutate(jobId, (current) => {
      assertLease(current, leaseToken);
      if (!["completed", "failed"].includes(patch.status)) fail("Invalid scan completion status.", 400);
      const next = patchJob(current, patch, true);
      if (patch.status === "completed" && !next.result) fail("A completed scan needs saved results.", 400, "INVALID_JOB_RESULT");
      const preserved = patch.status === "failed" && next.result;
      return { ...next, status: preserved ? "completed" : patch.status, stage: preserved ? "completed" : patch.status,
        completedAt: iso(now()), leaseHash: null, dispatchHash: null,
        error: preserved ? null : next.error, verificationFailure: preserved ? next.error || next.verificationFailure : next.verificationFailure };
    });
    await removeImage(jobId);
    return job;
  }

  async function markDispatchFailed({ jobId, dispatchToken, error }) {
    validJobId(jobId);
    return mutate(jobId, (current) => {
      if (!current || current.status !== "queued" || !matchesToken(dispatchToken, current.dispatchHash)) return current;
      return { ...current, dispatchError: cleanError(error) };
    });
  }

  /** Hourly caller; bounded reads, persisted cursors, and orphan-photo cleanup. */
  async function cleanupExpiredJobs({ limit = 200 } = {}) {
    limit = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 200));
    const checkpoint = await jobs.get("_cleanup", { type: "json", consistency: "strong" }) || {};
    const result = { jobsScanned: 0, imagesScanned: 0, imagesDeleted: 0, failures: 0 };
    const cursors = {};
    for (const [label, store] of [["jobs", jobs], ["images", images]]) {
      const listed = await store.list();
      const keys = (listed.blobs || []).map((blob) => blob.key).filter((key) => JOB_ID.test(key)).sort();
      const remaining = keys.filter((key) => key > (checkpoint[label] || ""));
      const selected = (remaining.length ? remaining : keys).slice(0, limit);
      cursors[label] = selected.length === limit ? selected.at(-1) : "";
      await mapWithConcurrency(selected, 8, async (id) => {
        try {
          if (label === "jobs") { result.jobsScanned++; await expire(id); }
          else {
            result.imagesScanned++;
            const metadata = await imageMetadata(id);
            if (!metadata || time(metadata.metadata?.expiresAt) > now()) return;
            const job = (await read(id))?.data;
            if (job && !TERMINAL.has(job.status)) await expire(id);
            if (await removeImage(id)) result.imagesDeleted++; else result.failures++;
          }
        } catch { result.failures++; }
      });
    }
    await jobs.setJSON("_cleanup", { ...cursors, updatedAt: iso(now()) });
    return result;
  }

  return { createJob, getJob, claimJob, getImage, updateJob, finishJob, markDispatchFailed, cleanupExpiredJobs, publicJob };
}
