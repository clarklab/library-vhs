import { randomUUID } from "node:crypto";
import { json, errorResponse, requireAuth, readBody } from "../lib/util.mjs";
import { structured, aiErrorResponse, safeRequestId, withDeadline } from "../lib/ai.mjs";
import { scanPhoto } from "../lib/scan-processor.mjs";

// Compatibility endpoint. The app uses scan-jobs for scans that need more than
// one synchronous request's time budget.
export const config = { path: "/api/scan" };

export function createScanHandler({ authenticate = requireAuth, runStructured = structured, timeoutMs = 52000 } = {}) {
  return async (req, context = {}) => {
    const started = Date.now();
    const requestId = safeRequestId(context.requestId) || randomUUID();
    let stage = "authentication";
    if (req.method !== "POST") return errorResponse("Not found", 404);
    try {
      return await withDeadline(async (signal) => {
        const auth = await authenticate(req);
        signal.throwIfAborted();
        if (!auth) return json({ error: "Not signed in.", code: "AUTH_REQUIRED", retryable: false, requestId }, 401);
        stage = "upload";
        const body = await readBody(req);
        signal.throwIfAborted();
        stage = "identification";
        const result = await scanPhoto(body, {
          runStructured, signal, requestId, timeoutMs: Math.min(48000, timeoutMs - (Date.now() - started)),
        });
        return json({ ...result, durationMs: Date.now() - started }, 200, { "cache-control": "no-store", "x-request-id": requestId });
      }, { timeoutMs, signal: req.signal });
    } catch (err) {
      return aiErrorResponse(err, { requestId, stage, durationMs: Date.now() - started });
    }
  };
}

export default createScanHandler();
