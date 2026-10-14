import { createHash, randomUUID } from "node:crypto";

const CONDITIONS = ["sealed", "mint", "good", "fair", "poor"];
const STATUSES = ["available", "sold", "hold", "keep"];
const PACKAGING = ["", "slipcase", "bigbox", "clamshell", "screener", "other"];
const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_TAPES_PER_BATCH = 100;
const WRITE_CONCURRENCY = 8;

/** Keep Blobs operations bounded without changing the order of their results. */
export async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("Invalid concurrency.");
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

/**
 * A clientId identifies one physical tape, not a title. Reusing it acknowledges
 * the existing record, including any edits made after the first save. Distinct
 * copies of the same movie must use distinct clientIds.
 *
 * Hashing keeps client input out of storage paths; the authenticated user prefix
 * isolates identical clientIds belonging to different collections.
 */
export async function saveTapeBatch({ store, userId, inputs, createId = randomUUID, onError = () => {} }) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_TAPES_PER_BATCH) {
    throw new RangeError(`Provide between 1 and ${MAX_TAPES_PER_BATCH} tapes.`);
  }

  const seen = new Set();
  const prepared = inputs.map((input, index) => {
    const fail = (code, error, clientId = null) => ({ failure: { index, clientId, code, error, retryable: false } });
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return fail("invalid_tape", "Each tape must be an object.");
    }
    const hasClientId = Object.hasOwn(input, "clientId");
    if (hasClientId && (typeof input.clientId !== "string" || !CLIENT_ID.test(input.clientId))) {
      return fail("invalid_client_id", "Use a clientId of 1–128 letters, numbers, underscores, or hyphens.");
    }
    const clientId = hasClientId ? input.clientId : null;
    if (typeof input.title !== "string" || !input.title.trim()) {
      return fail("missing_title", "Every tape needs a title.", clientId);
    }
    const tape = sanitizeTape(input);
    if (!tape.title) return fail("missing_title", "Every tape needs a title.", clientId);
    if (clientId && seen.has(clientId)) {
      return fail("duplicate_client_id", "Each tape in a batch needs a different clientId.", clientId);
    }
    if (clientId) seen.add(clientId);
    tape.id = clientId ? `c_${createHash("sha256").update(clientId).digest("hex")}` : createId();
    if (clientId) tape.clientId = clientId;
    tape.createdAt = new Date().toISOString();
    tape.updatedAt = tape.createdAt;
    return { tape, index, clientId };
  });

  const results = await mapWithConcurrency(prepared, WRITE_CONCURRENCY, async (entry) => {
    if (entry.failure) return entry;
    const { tape, index, clientId } = entry;
    const key = `${userId}/${tape.id}`;
    let writeError;
    try {
      // An existence check followed by an unconditional write races with retries.
      // onlyIfNew is atomic and never replaces a previously edited tape.
      await store.setJSON(key, tape, { onlyIfNew: true });
    } catch (err) {
      writeError = err;
    }
    try {
      // Confirm even an apparently successful write. @netlify/blobs 10.7.12 can
      // report modified:true on a failed conditional write (primitives#741).
      // This also recovers a successful write whose response was lost.
      const saved = await store.get(key, { type: "json", consistency: "strong" });
      if (saved?.id === tape.id && (clientId ? saved.clientId === clientId : !saved.clientId)) {
        return { tape: saved };
      }
      throw writeError || new Error("The tape write could not be confirmed.");
    } catch (err) {
      onError(err);
      return { failure: {
        index, clientId, code: "save_failed",
        error: "This tape could not be confirmed as saved.",
        retryable: Boolean(clientId),
      } };
    }
  });
  const failures = results.flatMap((result) => result.failure ? [result.failure] : []);
  return {
    tapes: results.flatMap((result) => result.tape ? [result.tape] : []),
    failedCount: failures.length,
    failedClientIds: failures.map((failure) => failure.clientId).filter(Boolean),
    failures,
  };
}

/**
 * Whitelist + coerce tape fields. When `partial` is true, only fields present
 * in the input are returned (for PATCH semantics).
 */
export function sanitizeTape(input, partial = false) {
  input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  const str = (v, max = 500) => ["string", "number", "boolean"].includes(typeof v)
    ? String(v).trim().slice(0, max) : "";
  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "number" && typeof v !== "string") return null;
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
      // https for OMDb posters, /api/cover/<id> for user-uploaded covers.
      return /^https:\/\//.test(s) || /^\/api\/cover\/[a-f0-9]{32}$/.test(s) ? s : "";
    },
    format: (v) => str(v, 40) || "VHS",
    edition: (v) => str(v, 200),
    label: (v) => str(v, 120),
    packaging: (v) => (PACKAGING.includes(v) ? v : ""),
    sealed: (v) => v === true || v === "true" || v === "yes" || v === 1,
    acquiredDate: (v) => str(v, 30),
    acquiredFrom: (v) => str(v, 200),
    barcode: (v) => str(v, 40),
    condition: (v) => (CONDITIONS.includes(v) ? v : ""),
    // Tapes are NOT for sale until the owner says so — new tapes default to
    // "keep" and get flipped to "available" deliberately.
    status: (v) => (STATUSES.includes(v) ? v : "keep"),
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
