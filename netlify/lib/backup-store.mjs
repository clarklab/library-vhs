import { createHash, randomUUID } from "node:crypto";
import { mapWithConcurrency } from "./tape-batch.mjs";

export const BACKUP_FORMAT = "tape-deck-account-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_PAGE_SIZE = 100;
export const MAX_COVER_BYTES = 2.5 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const COVER_ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export class BackupError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message) => { throw new BackupError(message); };
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
};
const string = (value, max, label, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(`Invalid ${label}.`);
  return value;
};
const identifier = (value, label = "record ID") => {
  if (typeof value !== "string" || !ID.test(value)) fail(`Invalid ${label}.`);
  return value;
};
const date = (value, label) => {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) fail(`Invalid ${label}.`);
  return value;
};
const allowed = (value, fields, label) => {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(`Unsupported ${label} field: ${key.slice(0, 80)}.`);
};
const strings = {
  title: 300, director: 300, genre: 120, runtime: 40, rated: 20, plot: 1200,
  imdbRating: 10, imdbId: 20, posterUrl: 600, format: 40, edition: 200,
  label: 120, packaging: 40, acquiredDate: 30, acquiredFrom: 200, barcode: 40,
  condition: 40, status: 40, soldDate: 30, location: 200, notes: 2000, source: 30,
};
const numbers = ["year", "pricePaid", "priceAsking", "priceSold"];
const tapeFields = new Set([...Object.keys(strings), ...numbers, "sealed", "actors", "tags", "id", "clientId", "createdAt", "updatedAt"]);
const scoutItemFields = new Set([...tapeFields, "artist", "photoId", "sourceIndex", "visual", "confidence", "estimate", "purchasedTapeId"]);
const listFields = new Set(["id", "clientId", "name", "items", "photos", "createdAt", "updatedAt", "revision"]);

/** Whitelist export fields so a backup can never carry account credentials. */
export function exportTape(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => tapeFields.has(key)));
}
export function exportScout(record) {
  return {
    ...Object.fromEntries(Object.entries(record).filter(([key]) => listFields.has(key) && key !== "items")),
    items: (record.items || []).map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => scoutItemFields.has(key)))),
  };
}

export function validateEnvelope(input) {
  object(input, "Backup");
  if (input.format !== BACKUP_FORMAT || input.version !== BACKUP_VERSION) fail("This backup format or version is not supported.");
  object(input.source, "Backup source");
  const accountId = identifier(input.source.accountId, "source account ID");
  if (!["covers", "tapes", "scouts"].includes(input.kind)) fail("Choose covers, tapes or scouts to restore.");
  const limit = input.kind === "tapes" ? BACKUP_PAGE_SIZE : 1;
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > limit) fail(`Restore between 1 and ${limit} ${input.kind} per request.`);
  const ids = new Set(), clients = new Set();
  for (const record of input.records) {
    if (typeof record?.id === "string") {
      if (ids.has(record.id)) fail("Each restored record must have a distinct ID.");
      ids.add(record.id);
    }
    if (typeof record?.clientId === "string") {
      if (clients.has(record.clientId)) fail("Each physical item must have a distinct clientId.");
      clients.add(record.clientId);
    }
  }
  if (input.exportedAt !== undefined) date(input.exportedAt, "export date");
  return { ...input, source: { accountId } };
}

function validateTapeFields(input, { scout = false } = {}) {
  object(input, "Tape");
  allowed(input, scout ? scoutItemFields : tapeFields, "tape");
  string(input.title, 300, "title", true);
  for (const [key, max] of Object.entries(strings)) if (Object.hasOwn(input, key)) string(input[key], max, key);
  for (const key of numbers) if (Object.hasOwn(input, key) && input[key] !== null && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) fail(`Invalid ${key}.`);
  for (const [key, choices] of [
    ["status", ["available", "sold", "hold", "keep"]],
    ["condition", ["", "sealed", "mint", "good", "fair", "poor"]],
    ["packaging", ["", "slipcase", "bigbox", "clamshell", "screener", "other"]],
  ]) if (Object.hasOwn(input, key) && !choices.includes(input[key])) fail(`Invalid ${key}.`);
  if (Object.hasOwn(input, "sealed") && typeof input.sealed !== "boolean") fail("Invalid sealed flag.");
  for (const [key, max, width] of [["actors", 12, 120], ["tags", 20, 40]]) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Array.isArray(input[key]) || input[key].length > max) fail(`Invalid ${key}.`);
    input[key].forEach((entry) => string(entry, width, key));
  }
  if (input.posterUrl && !/^https:\/\//.test(input.posterUrl) && !/^\/api\/cover\/[a-f0-9]{32}$/.test(input.posterUrl)) fail("Invalid cover URL.");
  for (const key of ["createdAt", "updatedAt"]) if (input[key] !== undefined) date(input[key], key);
  for (const key of ["id", "clientId"]) if (input[key] !== undefined) identifier(input[key], key);
  return structuredClone(input);
}

export function tapeDestinationId({ sourceId, userId, id, clientId }) {
  if (sourceId === userId) return id;
  return clientId ? `c_${digest(clientId)}` : `b_${digest(`${sourceId}\0${id}`)}`;
}
export function coverDestinationId({ sourceId, userId, id }) {
  return sourceId === userId ? id : digest(`${userId}\0${sourceId}\0${id}`).slice(0, 32);
}
const coverFromUrl = (url) => String(url || "").match(/^\/api\/cover\/([a-f0-9]{32})$/)?.[1];
function remapCover(record, context) {
  const coverId = coverFromUrl(record.posterUrl);
  if (coverId) record.posterUrl = `/api/cover/${coverDestinationId({ ...context, id: coverId })}`;
  return record;
}

function validateEstimate(input) {
  if (input === null) return null;
  object(input, "Estimate");
  allowed(input, new Set(["known", "low", "high", "typical", "demand", "factors", "summary", "source", "currency", "liveComps", "worthChecking", "estimatedAt"]), "estimate");
  for (const key of ["known", "liveComps", "worthChecking"]) if (typeof input[key] !== "boolean") fail(`Invalid estimate ${key}.`);
  for (const key of ["low", "high", "typical"]) if (input[key] !== null && (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1_000_000)) fail(`Invalid estimate ${key}.`);
  if (input.source !== "ai_estimate" || input.currency !== "USD" || input.liveComps !== false) fail("Estimates must be labeled as AI estimates without live sales data.");
  if (!["hot", "steady", "slow"].includes(input.demand)) fail("Invalid estimate demand.");
  if (!Array.isArray(input.factors) || input.factors.length > 4) fail("Invalid estimate factors.");
  input.factors.forEach((entry) => string(entry, 200, "estimate factor"));
  string(input.summary, 500, "estimate summary");
  if (input.known ? !(input.low !== null && input.typical !== null && input.high !== null && input.low <= input.typical && input.typical <= input.high) : [input.low, input.high, input.typical].some((value) => value !== null)) fail("The estimate amounts contradict its confidence.");
  if (input.worthChecking !== (input.known && input.typical >= 20)) fail("Invalid estimate worth-checking flag.");
  if (input.estimatedAt !== undefined) date(input.estimatedAt, "estimate date");
  return structuredClone(input);
}

export function validateScout(input) {
  object(input, "Scout list");
  allowed(input, listFields, "scout list");
  identifier(input.id);
  identifier(input.clientId, "scout clientId");
  if (input.id !== `s_${digest(input.clientId)}`) fail("Scout ID does not match its stable clientId.");
  string(input.name, 120, "scout name", true);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 1000) fail("A scout list must contain 1–1000 items.");
  const seen = new Set();
  const items = input.items.map((item) => {
    const clean = validateTapeFields(item, { scout: true });
    identifier(clean.clientId, "scout item clientId");
    if (seen.has(clean.clientId)) fail("Scout items must have distinct clientIds.");
    seen.add(clean.clientId);
    for (const [key, max] of [["artist", 200], ["photoId", 128], ["visual", 200]]) if (clean[key] !== undefined) string(clean[key], max, key);
    if (clean.sourceIndex !== undefined && clean.sourceIndex !== null && (!Number.isInteger(clean.sourceIndex) || clean.sourceIndex < 0 || clean.sourceIndex > 1000)) fail("Invalid source position.");
    if (clean.confidence !== undefined && !["high", "medium", "low", "manual"].includes(clean.confidence)) fail("Invalid title confidence.");
    if (clean.purchasedTapeId !== undefined && clean.purchasedTapeId !== null) identifier(clean.purchasedTapeId, "purchased tape ID");
    if (clean.estimate !== undefined) clean.estimate = validateEstimate(clean.estimate);
    return clean;
  });
  if (!Array.isArray(input.photos) || input.photos.length > 100) fail("Invalid scout photo references.");
  input.photos.forEach((photo) => {
    object(photo, "Photo reference");
    allowed(photo, new Set(["id", "name"]), "photo reference");
    string(photo.id, 128, "photo ID", true); string(photo.name, 160, "photo name");
  });
  for (const key of ["createdAt", "updatedAt"]) if (input[key] !== undefined) date(input[key], key);
  if (input.revision !== undefined) string(input.revision, 128, "revision");
  return { ...structuredClone(input), items };
}

async function writeNewRecord({ store, key, record, sameIdentity }) {
  const before = await store.get(key, { type: "json", consistency: "strong" });
  if (before) {
    if (!sameIdentity(before)) throw new BackupError("An existing record uses this ID for a different item. It was kept unchanged.", 409);
    return "existing";
  }
  const receipt = randomUUID();
  try { await store.setJSON(key, { ...record, backupReceipt: receipt }, { onlyIfNew: true }); }
  catch { /* Read back the record to resolve an ambiguous write outcome. */ }
  const confirmed = await store.get(key, { type: "json", consistency: "strong" });
  if (!confirmed) throw new BackupError("The restore could not be confirmed. Retry this same backup.", 503);
  if (!sameIdentity(confirmed)) throw new BackupError("An existing record uses this ID for a different item. It was kept unchanged.", 409);
  if (confirmed.backupReceipt === receipt) return "created";
  return "existing";
}

async function restoreCover({ input, stores, context }) {
  object(input, "Cover");
  allowed(input, new Set(["id", "contentType", "data", "sha256"]), "cover");
  if (!COVER_ID.test(input.id)) fail("Invalid cover ID.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.contentType)) fail("Unsupported cover image format.");
  if (typeof input.data !== "string" || input.data.length > Math.ceil(MAX_COVER_BYTES / 3) * 4 || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) fail("Invalid or oversized cover data.");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MAX_COVER_BYTES || bytes.toString("base64") !== input.data || !SHA.test(input.sha256) || digest(bytes) !== input.sha256) fail("The cover checksum does not match its image data.");
  const validMagic = input.contentType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : input.contentType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validMagic) fail("The cover bytes do not match their image format.");
  const id = coverDestinationId({ ...context, id: input.id });
  const existing = await stores.covers.getWithMetadata(id, { type: "arrayBuffer", consistency: "strong" });
  const matches = (blob) => blob?.metadata?.userId === context.userId && blob.metadata.contentType === input.contentType && digest(Buffer.from(blob.data)) === input.sha256;
  if (existing) {
    if (!matches(existing)) throw new BackupError("A different cover already uses this ID. It was kept unchanged.", 409);
    return { id, status: "existing" };
  }
  const receipt = randomUUID();
  try {
    await stores.covers.set(id, bytes, { onlyIfNew: true, metadata: { userId: context.userId, contentType: input.contentType, backupReceipt: receipt } });
  } catch { /* A confirmation read handles ambiguous network failures. */ }
  const confirmed = await stores.covers.getWithMetadata(id, { type: "arrayBuffer", consistency: "strong" });
  if (!confirmed) throw new BackupError("The cover restore could not be confirmed. Retry this same backup.", 503);
  if (!matches(confirmed)) throw new BackupError("A different cover already uses this ID. It was kept unchanged.", 409);
  return { id, status: confirmed.metadata.backupReceipt === receipt ? "created" : "existing" };
}

async function checkCover(record, stores, context) {
  const id = coverFromUrl(record.posterUrl);
  if (!id) return;
  const cover = await stores.covers.getMetadata(id, { consistency: "strong" });
  if (!cover || cover.metadata?.userId !== context.userId) throw new BackupError("Restore this item's uploaded cover before its record.", 409);
}

/** Stage bounded scout chunks, then publish the entire validated list atomically. */
async function restoreScoutPart({ raw, envelope, stores, context }) {
  const part = object(envelope.scoutPart, "Scout part");
  for (const key of ["index", "count", "totalItems"]) if (!Number.isInteger(part[key])) fail("Invalid scout part numbering.");
  if (part.totalItems < 1 || part.totalItems > 1000 || part.count !== Math.ceil(part.totalItems / BACKUP_PAGE_SIZE) || part.index < 0 || part.index >= part.count || !SHA.test(part.snapshotId)) fail("Invalid scout part numbering or snapshot checksum.");
  const expectedLength = Math.min(BACKUP_PAGE_SIZE, part.totalItems - part.index * BACKUP_PAGE_SIZE);
  const clean = validateScout(raw);
  if (clean.items.length !== expectedLength) fail("This scout part is incomplete.");
  const existing = await stores.scouts.get(`${context.userId}/${clean.id}`, { type: "json", consistency: "strong" });
  if (existing) {
    if (existing.clientId !== clean.clientId) throw new BackupError("An existing scout list uses this ID. It was kept unchanged.", 409);
    // The client sends every part in order on retry. Count this list once,
    // when its final part is acknowledged, even when it already exists.
    return { id: existing.id, status: part.index === part.count - 1 ? "existing" : "staged" };
  }
  const prefix = `${context.userId}/${digest(`${context.sourceId}\0${clean.id}\0${part.snapshotId}`)}`;
  const key = `${prefix}/${part.index}`;
  const staged = { record: raw, totalItems: part.totalItems, count: part.count };
  try { await stores.staging.setJSON(key, staged, { onlyIfNew: true }); }
  catch { /* Confirm the persisted chunk even when its response is lost. */ }
  const confirmed = await stores.staging.get(key, { type: "json", consistency: "strong" });
  if (!confirmed) throw new BackupError("The scout part could not be confirmed. Retry this backup.", 503);
  if (JSON.stringify(confirmed) !== JSON.stringify(staged)) throw new BackupError("A scout part conflicts with this backup's checksum.", 409);
  const parts = await mapWithConcurrency(Array.from({ length: part.count }, (_, index) => index), 4, (index) => stores.staging.get(`${prefix}/${index}`, { type: "json", consistency: "strong" }));
  if (parts.some((entry) => !entry)) return { id: clean.id, status: "staged" };
  const header = (entry) => JSON.stringify({ ...entry.record, items: [] });
  if (parts.some((entry) => entry.count !== part.count || entry.totalItems !== part.totalItems || header(entry) !== header(parts[0]))) fail("Scout part metadata does not match.");
  const combined = { ...parts[0].record, items: parts.flatMap((entry) => entry.record.items) };
  if (digest(JSON.stringify(combined)) !== part.snapshotId) fail("The complete scout list does not match its backup checksum.");
  const { scoutPart, ...fullEnvelope } = envelope;
  const completed = await restoreRecords({ stores, userId: context.userId, input: { ...fullEnvelope, records: [combined] } });
  const result = completed.results[0];
  if (result.status !== "failed") {
    // A failed cleanup never turns a confirmed import into a reported failure.
    await mapWithConcurrency(parts, 4, (_, index) => stores.staging.delete(`${prefix}/${index}`).catch(() => {}));
  }
  return result;
}

export async function restoreRecords({ stores, userId, input }) {
  const envelope = validateEnvelope(input);
  const context = { userId, sourceId: envelope.source.accountId };
  const fallbackDate = envelope.exportedAt || new Date().toISOString();
  const results = await mapWithConcurrency(envelope.records, 4, async (raw, index) => {
    const sourceId = typeof raw?.id === "string" ? raw.id : null;
    try {
      if (envelope.kind === "covers") return { sourceId, index, ...await restoreCover({ input: raw, stores, context }) };
      if (envelope.kind === "scouts" && envelope.scoutPart) return { sourceId, index, ...await restoreScoutPart({ raw, envelope, stores, context }) };
      const record = envelope.kind === "tapes" ? validateTapeFields(raw) : validateScout(raw);
      identifier(record.id);
      const originalId = record.id;
      if (envelope.kind === "tapes") {
        if (record.id.startsWith("c_") && (!record.clientId || record.id !== `c_${digest(record.clientId)}`)) fail("Tape ID does not match its stable clientId.");
        record.id = tapeDestinationId({ ...context, id: originalId, clientId: record.clientId });
        remapCover(record, context);
      } else {
        record.items = record.items.map((item) => {
          remapCover(item, context);
          if (item.purchasedTapeId) item.purchasedTapeId = tapeDestinationId({ ...context, id: item.purchasedTapeId, clientId: item.clientId });
          return item;
        });
        record.revision = randomUUID();
      }
      record.createdAt ||= fallbackDate;
      record.updatedAt ||= record.createdAt;
      record.backupOrigin = { accountId: context.sourceId, id: originalId };
      const store = envelope.kind === "tapes" ? stores.tapes : stores.scouts;
      const key = `${userId}/${record.id}`;
      // Existing records can be acknowledged without requiring an old cover that
      // the owner may have intentionally replaced or removed since the backup.
      const existing = await store.get(key, { type: "json", consistency: "strong" });
      if (!existing) {
        if (envelope.kind === "tapes") await checkCover(record, stores, context);
        else await mapWithConcurrency(record.items, 4, (item) => checkCover(item, stores, context));
      }
      const sameIdentity = (saved) => saved.id === record.id && (saved.clientId || null) === (record.clientId || null);
      const status = await writeNewRecord({ store, key, record, sameIdentity });
      return { sourceId, id: record.id, index, status };
    } catch (error) {
      return { sourceId, index, status: "failed", error: error instanceof BackupError ? error.message : "This record could not be restored. Retry this same backup.", retryable: !(error instanceof BackupError) || error.status >= 500 };
    }
  });
  return {
    created: results.filter((result) => result.status === "created").length,
    existing: results.filter((result) => result.status === "existing").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export async function listAccountRecords(store, userId) {
  const { blobs } = await store.list({ prefix: `${userId}/` });
  const records = await mapWithConcurrency(blobs, 8, async ({ key }) => {
    const record = await store.get(key, { type: "json", consistency: "strong" });
    if (!record) throw new BackupError("The account changed during backup. Please start the export again.", 409);
    return record;
  });
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

export async function backupManifest({ stores, userId }) {
  const [tapes, scouts] = await Promise.all([listAccountRecords(stores.tapes, userId), listAccountRecords(stores.scouts, userId)]);
  const cleanTapes = tapes.map(exportTape), cleanScouts = scouts.map(exportScout);
  const coverIds = [...new Set([...cleanTapes, ...cleanScouts.flatMap((list) => list.items)].map((item) => coverFromUrl(item.posterUrl)).filter(Boolean))].sort();
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, source: { accountId: userId }, exportedAt: new Date().toISOString(),
    tapeIds: cleanTapes.map((item) => item.id), scoutIds: cleanScouts.map((list) => list.id), coverIds,
    fingerprint: digest(JSON.stringify({ tapes: cleanTapes, scouts: cleanScouts })),
    excludes: ["passwords", "recovery codes", "sessions", "API keys", "unfinished browser scan drafts", "external poster image bytes"],
  };
}
