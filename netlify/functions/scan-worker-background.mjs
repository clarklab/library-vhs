import { randomUUID } from "node:crypto";
import { readBody } from "../lib/util.mjs";
import { safeRequestId, withDeadline } from "../lib/ai.mjs";
import { processScanJob, scanFailure, SCAN_JOB_BUDGET_MS } from "../lib/scan-processor.mjs";
import { createScanJobStore } from "../lib/scan-job-store.mjs";

// Netlify returns202 immediately and permits15min. We bound our work to8min.
// Its256KB invocation limit is why this request carries IDs, never the photo.
export const config = { background: true };

export function createScanWorker({ store, processJob = processScanJob } = {}) {
  return async (req, context = {}) => {
    if (req.method !== "POST") return;
    const body = await readBody(req);
    if (typeof body.jobId !== "string" || typeof body.dispatchToken !== "string" || body.jobId.length > 128 || body.dispatchToken.length > 128) return;
    const jobs = store || createScanJobStore();
    let claim;
    try {
      claim = await jobs.claimJob({ jobId: body.jobId, dispatchToken: body.dispatchToken });
    } catch (err) {
      // Background invocations cannot return an HTTP auth error (Netlify has
      // already sent202). Reject invalid/obsolete credentials without retries.
      if ([400, 403, 404, 409].includes(err?.status)) return;
      throw err;
    }
    if (!claim) return; // Wrong credential, duplicate invocation or already done.
    const { job, leaseToken } = claim;
    const requestId = safeRequestId(context.requestId) || randomUUID();
    const started = Date.now();
    let stage = "reading";
    let latestResult;
    try {
      await withDeadline(async (signal) => {
        const image = await jobs.getImage({ jobId: job.id, leaseToken });
        signal.throwIfAborted();
        const result = await processJob({ image, mode: job.mode, sourceId: job.sourceId }, {
          requestId, signal, timeoutMs: SCAN_JOB_BUDGET_MS - (Date.now() - started) - 5000,
          onProgress: async (patch) => {
            signal.throwIfAborted();
            stage = patch.stage || stage;
            if (patch.result) latestResult = patch.result;
            await jobs.updateJob({ jobId: job.id, leaseToken, patch });
          },
        });
        latestResult = result;
        signal.throwIfAborted();
        await jobs.finishJob({ jobId: job.id, leaseToken, patch: {
          status: "completed", stage: "completed", result, verificationFailure: result.verificationFailure || null,
        } });
        console.info("Background scan completed:", { requestId, jobId: job.id, durationMs: Date.now() - started, verificationFailed: Boolean(result.verificationFailure) });
      }, { timeoutMs: SCAN_JOB_BUDGET_MS });
    } catch (err) {
      const error = scanFailure(err, { requestId, stage, durationMs: Date.now() - started });
      console.error("Background scan failed:", { requestId, jobId: job.id, code: error.code, ...error.errorDetails });
      // Terminal state prevents Netlify's automatic retry from paying for the
      // same inference twice. If storage itself fails, the lease remains held.
      const patch = latestResult
        ? { status: "completed", stage: "completed", result: { ...latestResult, needsVerification: true, verificationFailure: error }, verificationFailure: error }
        : { status: "failed", stage: "failed", error };
      await withDeadline(() => jobs.finishJob({ jobId: job.id, leaseToken, patch }), { timeoutMs: 5000 });
    }
  };
}

export default createScanWorker();
