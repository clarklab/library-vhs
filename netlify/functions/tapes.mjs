import { tapesStore, json, errorResponse, requireAuth, newId, readBody } from "../lib/util.mjs";

export const config = { path: ["/api/tapes", "/api/tapes/:id"] };

const CONDITIONS = ["sealed", "mint", "good", "fair", "poor"];
const STATUSES = ["available", "sold", "hold", "keep"];

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
    await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })))
  ).filter(Boolean);
  tapes.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ tapes });
}

async function createTapes(req, auth) {
  const body = await readBody(req);
  // Accept a single tape or a batch: { tapes: [...] } or { ...tape }
  const inputs = Array.isArray(body.tapes) ? body.tapes : [body];
  if (inputs.length === 0) return errorResponse("Nothing to add.");
  if (inputs.length > 100) return errorResponse("Too many tapes in one request (max 100).");

  const store = tapesStore();
  const created = [];
  let failed = 0;
  for (const input of inputs) {
    const tape = sanitizeTape(input);
    if (!tape.title) continue;
    tape.id = newId();
    tape.createdAt = new Date().toISOString();
    tape.updatedAt = tape.createdAt;
    try {
      await store.setJSON(`${auth.userId}/${tape.id}`, tape);
      created.push(tape);
    } catch (err) {
      // Report partial success rather than failing the whole batch — a blind
      // retry would duplicate the tapes that were already written.
      console.error("tape write failed:", err?.message);
      failed++;
    }
  }
  if (created.length === 0 && failed === 0) return errorResponse("Every tape needs at least a title.");
  if (created.length === 0 && failed > 0) return errorResponse("Saving failed. Please try again.", 500);
  return json({ tapes: created, failedCount: failed }, 201);
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
  await tapesStore().delete(`${auth.userId}/${id}`);
  return json({ ok: true });
}

/**
 * Whitelist + coerce tape fields. When `partial` is true, only fields present
 * in the input are returned (for PATCH semantics).
 */
function sanitizeTape(input, partial = false) {
  const out = {};
  const str = (v, max = 500) => String(v ?? "").slice(0, max).trim();
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const fields = {
    title: (v) => str(v, 300),
    year: (v) => {
      const n = num(v);
      return n && n > 1880 && n < 2100 ? Math.round(n) : null;
    },
    director: (v) => str(v, 300),
    actors: (v) => (Array.isArray(v) ? v.map((a) => str(a, 120)).filter(Boolean).slice(0, 12) : []),
    genre: (v) => str(v, 120),
    runtime: (v) => str(v, 40),
    rated: (v) => str(v, 20),
    plot: (v) => str(v, 1200),
    imdbRating: (v) => str(v, 10),
    imdbId: (v) => str(v, 20),
    posterUrl: (v) => {
      const s = str(v, 600);
      return /^https:\/\//.test(s) ? s : "";
    },
    format: (v) => str(v, 40) || "VHS",
    edition: (v) => str(v, 200),
    barcode: (v) => str(v, 40),
    condition: (v) => (CONDITIONS.includes(v) ? v : ""),
    status: (v) => (STATUSES.includes(v) ? v : "available"),
    pricePaid: num,
    priceAsking: num,
    priceSold: num,
    soldDate: (v) => str(v, 30),
    location: (v) => str(v, 200),
    notes: (v) => str(v, 2000),
    tags: (v) => (Array.isArray(v) ? v.map((t) => str(t, 40)).filter(Boolean).slice(0, 20) : []),
    source: (v) => str(v, 30),
  };

  for (const [field, coerce] of Object.entries(fields)) {
    if (partial && !(field in input)) continue;
    out[field] = coerce(input[field]);
  }
  return out;
}
