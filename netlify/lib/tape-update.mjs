import { randomUUID } from "node:crypto";
import { sanitizeTape } from "./tape-batch.mjs";
import { valueSubject } from "./value-contract.mjs";

const failure = (message, status) => Object.assign(new Error(message), { status });

/** Merge against a fresh revision so late price results cannot erase another edit. */
export async function updateTapeRecord({ store, key, input }) {
  const patch = sanitizeTape(input, true);
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const existing = saved?.data;
    if (!existing) throw failure("Tape not found.", 404);
    const next = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString(), revision: randomUUID() };
    if (!next.title) throw failure("A tape needs a title.", 400);
    if (patch.estimate && valueSubject(input.estimateFor) !== valueSubject(next)) throw failure("This tape changed while its prices were being checked. Review its details and search again.", 409);
    if (!Object.hasOwn(patch, "estimate") && valueSubject(existing) !== valueSubject(next)) next.estimate = null;
    let writeError;
    try { await store.setJSON(key, next, { onlyIfMatch: saved.etag }); } catch (error) { writeError = error; }
    // Confirm even when the SDK reports success: conditional failures can look successful.
    const confirmed = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (confirmed?.data?.revision === next.revision) return confirmed.data;
    if (!confirmed) throw failure(writeError ? "Saving could not be confirmed. Retry this update." : "Tape not found.", writeError ? 503 : 404);
  }
  throw failure("This tape changed while saving. Retry this update.", 503);
}
