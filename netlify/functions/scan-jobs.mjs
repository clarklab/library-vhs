import { randomUUID } from "node:crypto";
import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { FriendlyError, aiErrorResponse, safeRequestId, withDeadline } from "../lib/ai.mjs";
import { validateScanInput, scanFailure } from "../lib/scan-processor.mjs";
import { createScanJobStore } from "../lib/scan-job-store.mjs";

export const config = { path: ["/api/scan-jobs", "/api/scan-jobs/:id"] };

export function workerURL(req, env = process.env, context = {}) {
  // Never dispatch a credential to a client-controlled Host/header/body URL.
  // Runtime context pins previews/old tabs to their own worker version; only
  // URL (the production address) is guaranteed as a runtime env variable.
  if (/^[a-f0-9]{24}$/i.test(context.deploy?.id || "") && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(context.site?.name || "")) {
    return `https://${context.deploy.id}--${context.site.name}.netlify.app/.netlify/functions/scan-worker-background`;
  }
  const configured = env.DEPLOY_URL || env.URL;
  if (configured) {
    const target = new URL(configured);
    if (target.protocol === "https:" && !target.username && !target.password) {
      return new URL("/.netlify/functions/scan-worker-background", target.origin).href;
    }
  }
  const local = new URL(req.url);
  if (env.NETLIFY_DEV === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)) {
    return new URL("/.netlify/functions/scan-worker-background", local.origin).href;
  }
  throw new FriendlyError("The background scanner is not available on this deployment. Retry after the site is deployed.", 503, { code: "SCAN_WORKER_UNAVAILABLE", retryable: true });
}

export async function dispatchScanJob({ req, jobId, dispatchToken, signal, context, fetcher = fetch }) {
  const response = await withDeadline((dispatchSignal) => fetcher(workerURL(req, process.env, context), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, dispatchToken }), signal: dispatchSignal, redirect: "error",
  }), { timeoutMs: 8000, signal });
  // A missing function can hit the SPA fallback (200 HTML). Only Netlify's
  // accepted async invocation response confirms that a worker was queued.
  if (response.status !== 202) {
    throw new FriendlyError("The scan was saved but its worker could not start. Retry this photo to reconnect.", 503, { code: "SCAN_DISPATCH_FAILED", retryable: true });
  }
}

export function createScanJobsHandler({ authenticate = requireAuth, store, dispatch = dispatchScanJob, timeoutMs = 25000 } = {}) {
  return async (req, context = {}) => {
    if (!["GET", "POST"].includes(req.method)) return errorResponse("Not found", 404);
    const started = Date.now();
    const requestId = safeRequestId(context.requestId) || randomUUID();
    let stage = "authentication";
    try {
      return await withDeadline(async (signal) => {
        const auth = await authenticate(req);
        signal.throwIfAborted();
        if (!auth) return json({ error: "Not signed in.", code: "AUTH_REQUIRED", retryable: false, requestId }, 401);
        const jobs = store || createScanJobStore();
        if (req.method === "GET") {
          const url = new URL(req.url);
          const jobId = context.params?.id || url.pathname.match(/^\/api\/scan-jobs\/([^/]+)$/)?.[1] || url.searchParams.get("id");
          const job = await jobs.getJob({ userId: auth.userId, jobId });
          if (!job) return json({ error: "This scan could not be found. Retry the photo to start again.", code: "SCAN_JOB_NOT_FOUND", retryable: false, requestId }, 404);
          return json({ job: jobs.publicJob(job), pollAfterMs: 1500, requestId }, 200, { "cache-control": "no-store" });
        }
        stage = "upload";
        const body = await readBody(req);
        signal.throwIfAborted();
        const { mode, sourceId } = validateScanInput(body);
        const created = await jobs.createJob({ userId: auth.userId, clientId: body.clientId, image: body.image, mode, sourceId });
        signal.throwIfAborted();
        let job = created.job;
        let dispatchError;
        if (created.dispatchToken) {
          try {
            await dispatch({ req, jobId: job.id, dispatchToken: created.dispatchToken, signal, context });
          } catch (err) {
            dispatchError = scanFailure(err, { requestId, stage, durationMs: Date.now() - started });
            // A timed-out dispatch may still have reached the worker. Store CAS
            // must only annotate a still-queued job with this exact credential.
            job = await jobs.markDispatchFailed({ jobId: job.id, dispatchToken: created.dispatchToken, error: dispatchError });
          }
        }
        return json({ job: jobs.publicJob(job), pollAfterMs: 1500, requestId, ...(dispatchError ? { dispatchError } : {}) }, 202, { "cache-control": "no-store" });
      }, { timeoutMs, signal: req.signal });
    } catch (err) {
      return aiErrorResponse(err, { requestId, stage, durationMs: Date.now() - started });
    }
  };
}

export default createScanJobsHandler();
