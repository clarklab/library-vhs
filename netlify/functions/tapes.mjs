import { tapesStore, coversStore, json, errorResponse, requireAuth, newId, readBody } from "../lib/util.mjs";

import { MAX_TAPES_PER_BATCH, mapWithConcurrency, sanitizeTape, saveTapeBatch } from "../lib/tape-batch.mjs";

export const config = { path: ["/api/tapes", "/api/tapes/:id"] };

export default async (req, context) => {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse("Not signed in.", 401);

  const id = context.params?.id;

  try {
    if (req.method === "GET" && !id) return await listTapes(auth);
    if (req.method === "POST" && !id) return await createTapes(req, auth);
    if ((req.method === "PUT" || req.method === "PATCH") && id) return await updateTape(req, auth, id);
    if (req.method === "DELETE" && id) return await deleteTape(auth, id);
    return errorResponse("Not found", 404);
  } catch (err) {
    console.error("tapes error:", err);
    return errorResponse("Something went wrong. Please try again.", 500);
  }
};

async function listTapes(auth) {
  const store = tapesStore();
  const prefix = `${auth.userId}/`;
  const { blobs } = await store.list({ prefix });
  const tapes = (
    await mapWithConcurrency(blobs, 16, (blob) => store.get(blob.key, { type: "json" }))
  ).filter(Boolean);
  tapes.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ tapes });
}

async function createTapes(req, auth) {
  const body = await readBody(req);
  // Accept a single tape or a batch: { tapes: [...] } or { ...tape }.
  if (Object.hasOwn(body, "tapes") && !Array.isArray(body.tapes)) {
    return errorResponse("Tapes must be an array.");
  }
  const inputs = Array.isArray(body.tapes) ? body.tapes : [body];
  if (inputs.length === 0) return errorResponse("Nothing to add.");
  if (inputs.length > MAX_TAPES_PER_BATCH) {
    return errorResponse(`Too many tapes in one request (max ${MAX_TAPES_PER_BATCH}).`);
  }
  const result = await saveTapeBatch({
    store: tapesStore(), userId: auth.userId, inputs, createId: newId,
    onError: (err) => console.error("tape write could not be confirmed:", err?.message),
  });
  if (!result.tapes.length) {
    const storageFailed = result.failures.some((failure) => failure.code === "save_failed");
    return json({
      ...result,
      error: storageFailed ? "Saving could not be confirmed. Please try again." : "Check the tape details and try again.",
    }, storageFailed ? 503 : 400);
  }
  return json(result, 201);
}

async function updateTape(req, auth, id) {
  const store = tapesStore();
  const key = `${auth.userId}/${id}`;
  const existing = await store.get(key, { type: "json" });
  if (!existing) return errorResponse("Tape not found.", 404);

  const body = await readBody(req);
  const patch = sanitizeTape(body, true);
  const updated = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (!updated.title) return errorResponse("A tape needs a title.");
  await store.setJSON(key, updated);
  return json({ tape: updated });
}

async function deleteTape(auth, id) {
  const store = tapesStore();
  const key = `${auth.userId}/${id}`;
  const existing = await store.get(key, { type: "json" });
  await store.delete(key);
  // Deleting a tape also deletes its uploaded cover, if it had one.
  const cover = String(existing?.posterUrl || "").match(/^\/api\/cover\/([a-f0-9]{32})$/);
  if (cover) await coversStore().delete(cover[1]).catch(() => {});
  return json({ ok: true });
}
