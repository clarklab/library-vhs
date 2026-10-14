import { createHash, randomUUID } from "node:crypto";
import { mapWithConcurrency, sanitizeTape } from "./tape-batch.mjs";
import { MEDIA_FORMATS, storedValue, valueSubject } from "./value-contract.mjs";

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_SCOUT_ITEMS = 1000;
export class ScoutError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const text = (value, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const estimateSubject = valueSubject;
export const scoutKey = (userId, id) => `${userId}/${id}`;
const idFor = (clientId) => `s_${createHash("sha256").update(clientId).digest("hex")}`;
const assertClientId = (value) => {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) throw new ScoutError("Each list and item needs a stable clientId.");
  return value;
};

export function sanitizeScoutInput(input) {
  const clientId = assertClientId(input?.clientId);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_SCOUT_ITEMS) throw new ScoutError(`A scout list needs 1–${MAX_SCOUT_ITEMS} items.`);
  const seen = new Set();
  const items = input.items.map((item) => {
    assertClientId(item?.clientId);
    if (seen.has(item.clientId)) throw new ScoutError("Each physical item needs a different clientId.");
    seen.add(item.clientId);
    if (!text(item.title, 300)) throw new ScoutError("Every item needs a title.");
    const tape = sanitizeTape(item);
    const format = MEDIA_FORMATS.includes(item.format) ? item.format : item.format === undefined ? "VHS" : "Other";
    const record = {
      ...tape, format, clientId: item.clientId, artist: text(item.artist),
      photoId: text(item.photoId, 128), sourceIndex: Number.isInteger(item.sourceIndex) ? item.sourceIndex : null,
      visual: text(item.visual), confidence: ["high", "medium", "low", "manual"].includes(item.confidence) ? item.confidence : "manual",
      estimate: null, purchasedTapeId: null,
      marker: item.marker && Number.isFinite(item.marker.x) && Number.isFinite(item.marker.y) && item.marker.x >= 0 && item.marker.x <= 1 && item.marker.y >= 0 && item.marker.y <= 1 ? { x: item.marker.x, y: item.marker.y } : null,
      markerIssue: ["unplaced", "overlap"].includes(item.markerIssue) ? item.markerIssue : null,
    };
    if (item.estimate && estimateSubject(item.estimateFor) === estimateSubject(record)) record.estimate = storedValue(item.estimate);
    return record;
  });
  const photos = (Array.isArray(input.photos) ? input.photos : []).slice(0, 100).flatMap((photo) => {
    const id = text(photo?.id, 128);
    return id ? [{ id, name: text(photo.name, 160) || "Source photo" }] : [];
  });
  return { clientId, name: text(input.name, 120) || "Untitled scout list", items, photos };
}

/** Apply a small merge against the latest revision; never overwrite concurrent edits. */
async function mutateScout({ store, key, change }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const next = await change(existing?.data || null);
    if (next === existing?.data) return next;
    next.revision = randomUUID();
    next.updatedAt = new Date().toISOString();
    let writeError;
    try {
      await store.setJSON(key, next, existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
    } catch (error) { writeError = error; }
    // Reads also guard the SDK's false-success conditional-write failure mode.
    const confirmed = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (confirmed?.data?.revision === next.revision) return confirmed.data;
    if (writeError && !confirmed) throw new ScoutError("The list could not be confirmed as saved. Retry with the same draft.", 503);
  }
  throw new ScoutError("This list changed while saving. Retry to merge your remaining items.", 503);
}

export async function saveScout({ store, userId, input }) {
  const clean = sanitizeScoutInput(input);
  const id = idFor(clean.clientId);
  return mutateScout({ store, key: scoutKey(userId, id), change(existing) {
    if (!existing) return { ...clean, id, createdAt: new Date().toISOString() };
    const ids = new Set(existing.items.map((item) => item.clientId));
    const added = clean.items.filter((item) => !ids.has(item.clientId));
    if (!added.length) return existing;
    if (existing.items.length + added.length > MAX_SCOUT_ITEMS) throw new ScoutError(`This list already has ${existing.items.length} items. Start another list.`);
    const photos = new Map((existing.photos || []).map((photo) => [photo.id, photo]));
    for (const photo of clean.photos) if (!photos.has(photo.id)) photos.set(photo.id, photo);
    return { ...existing, items: [...existing.items, ...added], photos: [...photos.values()].slice(0, 100) };
  } });
}

export async function patchScout({ store, tapeStore, userId, id, patch }) {
  const updates = patch?.items;
  if (updates !== undefined && (!Array.isArray(updates) || updates.length > 100)) throw new ScoutError("Update at most 100 items at a time.");
  const cleanUpdates = await mapWithConcurrency(updates || [], 8, async (input) => {
    assertClientId(input?.clientId);
    const update = { clientId: input.clientId };
    for (const [field, max] of [["title", 300], ["edition", 200], ["artist", 200], ["visual", 200]]) {
      if (!Object.hasOwn(input, field)) continue;
      if (typeof input[field] !== "string") throw new ScoutError(`Invalid ${field}.`);
      update[field] = text(input[field], max);
      if (field === "title" && !update.title) throw new ScoutError("Every item needs a title.");
    }
    if (Object.hasOwn(input, "format")) {
      if (!MEDIA_FORMATS.includes(input.format)) throw new ScoutError("Choose VHS, DVD, CD, Blu-ray or Other.");
      update.format = input.format;
    }
    if (Object.hasOwn(input, "year")) {
      if (input.year !== null && !["string", "number"].includes(typeof input.year)) throw new ScoutError("Invalid release year.");
      const year = input.year === null || input.year === "" ? null : Number(input.year);
      if (year !== null && (!Number.isInteger(year) || year < 1888 || year > 2100)) throw new ScoutError("Enter a valid release year, or leave it blank.");
      update.year = year;
    }
    if (Object.hasOwn(input, "estimate")) {
      if (!input.estimate || typeof input.estimate !== "object") throw new ScoutError("Invalid estimate.");
      if (!input.estimateFor || typeof input.estimateFor.title !== "string" || !MEDIA_FORMATS.includes(input.estimateFor.format)) {
        throw new ScoutError("Include the identification used for this estimate.");
      }
      update.estimateFor = estimateSubject(input.estimateFor);
      update.estimate = storedValue(input.estimate);
    }
    if (Object.hasOwn(input, "purchasedTapeId")) {
      const tapeId = text(input.purchasedTapeId, 128);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(tapeId)) throw new ScoutError("Invalid purchased item.");
      const tape = await tapeStore.get(scoutKey(userId, tapeId), { type: "json", consistency: "strong" });
      if (!tape || tape.clientId !== input.clientId) throw new ScoutError("Add this item to your collection before marking it purchased.");
      update.purchasedTapeId = tapeId;
    }
    return update;
  });
  return mutateScout({ store, key: scoutKey(userId, id), change(existing) {
    if (!existing) throw new ScoutError("Scout list not found.", 404);
    const next = { ...existing };
    if (Object.hasOwn(patch, "name")) {
      if (!text(patch.name, 120)) throw new ScoutError("Give this list a name.");
      next.name = text(patch.name, 120);
    }
    const updatesById = new Map(cleanUpdates.map((item) => [item.clientId, item]));
    if (cleanUpdates.some((item) => !existing.items.some((old) => old.clientId === item.clientId))) throw new ScoutError("An item is no longer in this list.");
    next.items = existing.items.map((item) => {
      const update = updatesById.get(item.clientId);
      if (!update) return item;
      const { estimateFor, ...fields } = update;
      if (estimateFor && estimateFor !== estimateSubject(item)) {
        throw new ScoutError("This find changed while its estimate was being prepared. Refresh the list before estimating it again.", 409);
      }
      const identificationChanged = ["title", "year", "format", "edition", "artist"].some((field) => (
        Object.hasOwn(fields, field) && fields[field] !== item[field]
      ));
      return { ...item, ...fields, ...(identificationChanged ? { estimate: null } : {}) };
    });
    return next;
  } });
}

export function scoutSummary(list) {
  return {
    id: list.id, name: list.name, createdAt: list.createdAt, updatedAt: list.updatedAt,
    itemCount: list.items.length, photoCount: list.photos?.length || 0,
    purchasedCount: list.items.filter((item) => item.purchasedTapeId).length,
    estimatedCount: list.items.filter((item) => item.estimate).length,
    worthCheckingCount: list.items.filter((item) => item.estimate?.worthChecking).length,
  };
}
