import { getStore } from "@netlify/blobs";
import { json, errorResponse, requireAuth, readBody, tapesStore } from "../lib/util.mjs";
import { mapWithConcurrency } from "../lib/tape-batch.mjs";
import { ScoutError, saveScout, patchScout, scoutKey, scoutSummary } from "../lib/scout-store.mjs";

export const config = { path: ["/api/scouts", "/api/scouts/:id"] };
const scoutsStore = () => getStore({ name: "scouts", consistency: "strong" });
const reply = (data, status = 200) => json(data, status, { "cache-control": "no-store" });

export function createScoutsHandler({ authenticate = requireAuth, getScouts = scoutsStore, getTapes = tapesStore } = {}) {
  return async (req, context = {}) => {
    try {
      const auth = await authenticate(req);
      if (!auth) return errorResponse("Not signed in.", 401);
      const id = context.params?.id;
      if (id && !/^s_[a-f0-9]{64}$/.test(id)) return errorResponse("Scout list not found.", 404);
      const store = getScouts();
      if (req.method === "GET") {
        if (id) {
          const list = await store.get(scoutKey(auth.userId, id), { type: "json" });
          return list ? reply({ list }) : errorResponse("Scout list not found.", 404);
        }
        const { blobs } = await store.list({ prefix: `${auth.userId}/` });
        const records = await mapWithConcurrency(blobs, 8, (blob) => store.get(blob.key, { type: "json" }));
        const lists = records.filter(Boolean).map(scoutSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return reply({ lists });
      }
      if (req.method === "POST" && !id) {
        const list = await saveScout({ store, userId: auth.userId, input: await readBody(req) });
        return reply({ list }, 201);
      }
      if (req.method === "PATCH" && id) {
        const list = await patchScout({ store, tapeStore: getTapes(), userId: auth.userId, id, patch: await readBody(req) });
        return reply({ list });
      }
      if (req.method === "DELETE" && id) {
        await store.delete(scoutKey(auth.userId, id));
        return reply({ ok: true });
      }
      return errorResponse("Not found", 404);
    } catch (error) {
      if (error instanceof ScoutError) return reply({ error: error.message, retryable: error.status >= 500 }, error.status);
      console.error("Scout request failed:", { name: error?.name });
      return reply({ error: "The scout list could not be loaded or saved. Please retry.", retryable: true }, 503);
    }
  };
}

export default createScoutsHandler();
