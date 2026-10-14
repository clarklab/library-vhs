// Durable, account-scoped photo batches. No DOM dependency: queue and save logic are testable.
import { api, getToken } from "./api.js";
import { resizeImage } from "./util.js";

export const MAX_PHOTOS = 10;
export const SCAN_CONCURRENCY = 2;
const newId = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const pendingStatuses = new Set(["queued", "processing", "preparing"]);
let current = null;
let opening = null;
let generation = 0;
let dbPromise;

const storedImageKeys = new Set();
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("Draft storage is unavailable in this browser."));
    const req = indexedDB.open("vhs-vault-scan", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "userId" });
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "key" }).createIndex("userId", "userId");
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

export const draftStore = {
  async load(userId) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "photos"]);
      const req = tx.objectStore("sessions").get(userId);
      let draft = null;
      req.onsuccess = () => {
        draft = req.result || null;
        for (const photo of draft?.photos || []) {
          if (photo.image) continue; // Migrate a first-version draft on the next write.
          const key = `${userId}:${photo.id}`;
          const imageReq = tx.objectStore("photos").get(key);
          imageReq.onsuccess = () => {
            photo.image = imageReq.result?.image || "";
            if (photo.image) storedImageKeys.add(key);
          };
        }
      };
      tx.oncomplete = () => resolve(draft);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Could not read draft storage."));
    });
  },
  async put(value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "photos"], "readwrite");
      const images = tx.objectStore("photos");
      const addedKeys = [];
      const retainedKeys = new Set();
      const photos = value.photos.map(({ image, ...photo }) => {
        const key = `${value.userId}:${photo.id}`;
        retainedKeys.add(key);
        // Images never change for an existing photo ID. Avoid cloning megabytes on each keystroke.
        if (image && !storedImageKeys.has(key)) { images.put({ key, userId: value.userId, image }); addedKeys.push(key); }
        return photo;
      });
      tx.objectStore("sessions").put({ ...value, photos });
      const oldKeys = images.index("userId").getAllKeys(value.userId);
      const removedKeys = [];
      oldKeys.onsuccess = () => {
        for (const key of oldKeys.result) if (!retainedKeys.has(key)) { images.delete(key); removedKeys.push(key); }
      };
      tx.oncomplete = () => {
        addedKeys.forEach((key) => storedImageKeys.add(key));
        removedKeys.forEach((key) => storedImageKeys.delete(key));
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Draft storage was interrupted."));
    });
  },
};

export function isItemSaved(item) { return Boolean(item.savedId || item.scoutSavedId); }

export function normalizeTitle(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^(the|a|an) /, "");
}

export function duplicateWarnings(items, library = []) {
  const index = new Map();
  for (const tape of library) {
    const key = normalizeTitle(tape.title);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(tape);
  }
  const warnings = new Map();
  const byTitle = new Map();
  for (const item of items) {
    if (!item.include || isItemSaved(item) || !item.title.trim()) continue;
    const key = normalizeTitle(item.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(item);
  }
  for (const [key, matches] of byTitle) {
    for (const item of matches) {
      const sameYear = (other) => (!item.year || !other.year || Number(other.year) === Number(item.year)) && (!item.format || !other.format || item.format === "unknown" || other.format === "unknown" || item.format.toLowerCase() === other.format.toLowerCase());
      const batch = matches.filter((other) => other !== item && sameYear(other));
      const existing = (index.get(key) || []).filter(sameYear);
      if (batch.length || existing.length) warnings.set(item.clientId, { batch: batch.length, library: existing.length });
    }
  }
  return warnings;
}

export function requiresReview(item) {
  return item.include !== false && !isItemSaved(item) && (!item.title.trim() || item.format === "unknown" || (item.needsReview && !item.confirmed));
}

export function requiresPhotoReview(photo) {
  return photo.status === "complete" && photo.needsPhotoReview && !photo.reviewed;
}

export function sessionSummary(draft) {
  if (!draft) return { photos: 0, completed: 0, pending: 0, errors: 0, tapes: 0, needsReview: 0, photoReviews: 0, saved: 0, paused: true };
  return {
    photos: draft.photos.length,
    completed: draft.photos.filter((p) => p.status === "complete").length,
    pending: draft.photos.filter((p) => pendingStatuses.has(p.status)).length,
    errors: draft.photos.filter((p) => p.status === "error").length,
    tapes: draft.items.filter((i) => i.include !== false && !isItemSaved(i)).length,
    needsReview: draft.items.filter(requiresReview).length,
    photoReviews: draft.photos.filter(requiresPhotoReview).length,
    saved: draft.items.filter((i) => isItemSaved(i)).length,
    paused: draft.paused,
  };
}

export function tapePayload(item, draft) {
  const payload = {
    clientId: item.clientId, title: item.title.trim(), year: item.year || null,
    edition: item.edition || "", format: item.format || "VHS", source: "scan", status: "keep",
    pricePaid: item.pricePaid ?? draft.pricePaid ?? null,
    priceAsking: item.priceAsking ?? draft.priceAsking ?? null,
    location: draft.location || "",
  };
  for (const key of ["director", "actors", "genre", "runtime", "rated", "plot", "imdbRating", "imdbId", "posterUrl"]) {
    if (item[key]) payload[key] = item[key];
  }
  return payload;
}

export class ScanSession {
  constructor(userId, saved, { client = api, storage = draftStore, resize = resizeImage, id = newId, expectedToken = typeof localStorage === "undefined" ? undefined : getToken() } = {}) {
    this.client = client;
    this.expectedToken = expectedToken;
    this.storage = storage;
    this.resize = resize;
    this.id = id;
    this.draft = saved || { userId, id: id(), photos: [], items: [], mode: "fast", destination: "collection", scoutName: "", paused: true, location: "", createdAt: Date.now() };
    this.draft.paused = true;
    this.draft.photos.forEach((photo) => {
      if (photo.status === "processing") photo.status = "queued";
      if (!photo.image && photo.status !== "preparing") {
        photo.status = "error";
        photo.error = "This photo is no longer on this device. Remove it and choose it again.";
      }
      if (photo.status === "preparing") {
        photo.status = "error";
        photo.error = "Photo preparation was interrupted. Remove it and choose it again.";
      }
    });
    this.listeners = new Set();
    this.controllers = new Map();
    this.persistChain = Promise.resolve();
    this.prepareChain = Promise.resolve();
    this.preparing = 0;
    this.saving = false;
    this.enriching = false;
    this.disposed = false;
    this.storageError = "";
    this.saveError = "";
    this.enrichMessage = "";
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { if (!this.disposed) this.listeners.forEach((listener) => listener(this)); }
  changed({ immediate = false } = {}) {
    this.draft.updatedAt = Date.now();
    this.emit();
    clearTimeout(this.persistTimer);
    if (immediate) return this.persist();
    this.persistTimer = setTimeout(() => this.persist(), 180);
  }
  persist() {
    clearTimeout(this.persistTimer);
    const { photos, ...metadata } = this.draft;
    const snapshot = { ...clone(metadata), photos: photos.map(({ image, ...photo }) => ({ ...clone(photo), image })) };
    this.persistChain = this.persistChain.catch(() => {}).then(() => this.storage.put(snapshot)).then(() => {
      if (this.storageError) { this.storageError = ""; this.emit(); }
      return true;
    }).catch(() => {
      this.storageError = "This browser could not save your draft. Keep this tab open until you finish; freeing device storage may help.";
      this.emit();
      return false;
    });
    return this.persistChain;
  }

  addFiles(files) {
    const room = MAX_PHOTOS - this.draft.photos.length;
    const accepted = Array.from(files).slice(0, room);
    for (const file of accepted) {
      const photo = { id: this.id(), name: file.name || "Camera photo", status: "preparing", image: "", error: "", notes: "", warnings: [] };
      this.draft.photos.push(photo);
      this.preparing++;
      this.prepareChain = this.prepareChain.then(async () => {
        try {
          if (this.disposed || !this.draft.photos.includes(photo)) return;
          photo.image = await this.resize(file, 2400, 0.88);
          if (this.disposed || !this.draft.photos.includes(photo)) return;
          photo.status = "queued";
        } catch (error) {
          photo.status = "error";
          photo.error = error.message || "This image could not be opened. Try a JPEG or PNG photo.";
        } finally {
          this.preparing = Math.max(0, this.preparing - 1);
          if (!this.disposed) { await this.changed({ immediate: true }); this.pump(); }
        }
      });
    }
    this.changed();
    return { added: accepted.length, skipped: Math.max(0, files.length - accepted.length) };
  }

  resume() { this.draft.paused = false; this.changed(); this.pump(); }
  pause() {
    this.draft.paused = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.draft.photos.forEach((photo) => { if (photo.status === "processing") photo.status = "queued"; });
    this.changed({ immediate: true });
  }
  dispose() { this.pause(); this.disposed = true; this.listeners.clear(); this.enrichController?.abort(); this.persistChain.finally(() => this.releaseLock?.()); }
  pump() {
    if (this.disposed || this.draft.paused) return;
    while (this.controllers.size < SCAN_CONCURRENCY) {
      const photo = this.draft.photos.find((p) => p.status === "queued" && p.image && !this.controllers.has(p.id));
      if (!photo) return;
      this.runPhoto(photo);
    }
  }
  async runPhoto(photo) {
    const controller = new AbortController();
    this.controllers.set(photo.id, controller);
    photo.status = "processing";
    photo.stage = "reading";
    photo.error = "";
    const mode = this.draft.mode;
    this.changed();
    try {
      let response = photo.initialResult;
      if (!response) {
        response = await this.client.scanPhoto(photo.image, { signal: controller.signal, mode, sourceId: photo.id, expectedToken: this.expectedToken });
        if (this.disposed || !this.draft.photos.includes(photo)) return;
        photo.initialResult = response;
        photo.initialMode = mode;
        await this.changed({ immediate: true });
      }
      if (this.disposed || controller.signal.aborted || !this.draft.photos.includes(photo)) return;
      photo.verification = response.verification || null;
      photo.verificationError = photo.verificationAttempted && !photo.verified ? "Double-checking was interrupted. Your first reading is kept; check this photo before saving." : "";
      // One stronger pass only. Retain the first reading if verification is unavailable.
      if ((photo.initialMode || mode) !== "thorough" && response.needsVerification && !photo.verificationAttempted) {
        photo.verificationAttempted = true;
        photo.stage = "verifying";
        await this.changed({ immediate: true });
        try {
          const verified = await this.client.scanPhoto(photo.image, {
            signal: controller.signal, mode: "thorough", sourceId: photo.id, expectedToken: this.expectedToken,
            verificationContext: {
              countedCount: response.verification?.countedCount ?? null,
              uncertainCount: response.verification?.uncertainCount ?? 0,
              tapes: response.tapes,
            },
          });
          if (Array.isArray(verified?.tapes)) { response = verified; photo.initialResult = verified; photo.verified = true; }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          photo.verificationError = "The closer look was unavailable. Your first reading is kept; check this photo before saving.";
        }
      }
      if (this.disposed || controller.signal.aborted || !this.draft.photos.includes(photo)) return;
      const tapes = Array.isArray(response?.tapes) ? response.tapes : [];
      photo.status = "complete";
      photo.stage = "complete";
      photo.verification = response.verification || null;
      photo.needsPhotoReview = Boolean(photo.verificationError || !response.verification || response.verification.status !== "matched" || response.verification.uncertainCount > 0);
      photo.reviewed = false;
      photo.notes = response.notes || "";
      photo.warnings = response.warnings || [];
      photo.model = response.model;
      photo.mode = response.mode || mode;
      photo.reportedCount = response.reportedCount ?? response.count ?? tapes.length;
      photo.durationMs = response.durationMs;
      this.draft.items.push(...tapes.map((tape, index) => ({
        ...tape, title: String(tape.title || ""), format: tape.format || "unknown", clientId: this.id(), photoId: photo.id,
        sourceIndex: tape.sourceIndex || index + 1, include: true, confirmed: false,
        needsReview: tape.needsReview === true || tape.confidence !== "high",
      })));
      delete photo.initialResult;
      await this.changed({ immediate: true });
    } catch (error) {
      if (this.disposed || !this.draft.photos.includes(photo)) return;
      if (controller.signal.aborted) photo.status = "queued";
      else {
        photo.status = "error";
        photo.error = error.message || "This photo could not be read. Try again.";
        photo.retryable = error.retryable !== false;
        photo.retryAfter = Date.now() + (error.retryAfterMs || 0);
      }
      this.changed({ immediate: true });
    } finally {
      this.controllers.delete(photo.id);
      this.emit();
      this.pump();
    }
  }
  retryPhoto(id) {
    const photo = this.draft.photos.find((p) => p.id === id);
    if (!photo?.image || photo.status !== "error") return;
    photo.status = "queued";
    photo.error = "";
    this.resume();
  }
  removePhoto(id) {
    if (this.saving) return;
    this.controllers.get(id)?.abort();
    this.draft.photos = this.draft.photos.filter((p) => p.id !== id);
    this.draft.items = this.draft.items.filter((i) => i.photoId !== id || isItemSaved(i));
    this.changed({ immediate: true });
  }
  confirmPhoto(id, reviewed) {
    if (this.saving) return;
    const photo = this.draft.photos.find((p) => p.id === id);
    if (!photo) return;
    photo.reviewed = reviewed;
    this.changed();
  }
  updateItem(id, patch) {
    if (this.saving) return;
    const item = this.draft.items.find((i) => i.clientId === id);
    if (!item || isItemSaved(item)) return;
    if (Object.hasOwn(patch, "title") && patch.title !== item.title) {
      for (const field of ["director", "actors", "genre", "runtime", "rated", "plot", "imdbRating", "imdbId", "posterUrl"]) delete item[field];
      item.matched = false;
    }
    Object.assign(item, patch);
    if (Object.hasOwn(patch, "include") || Object.hasOwn(patch, "format")) {
      const photo = this.draft.photos.find((p) => p.id === item.photoId);
      if (photo?.needsPhotoReview) photo.reviewed = false;
    }
    this.changed();
  }
  addManual(title, photoId = "") {
    const item = { clientId: this.id(), title: title.trim(), year: null, format: "VHS", photoId, sourceIndex: null, include: true, confirmed: true, needsReview: false, confidence: "manual" };
    if (!item.title || this.saving) return;
    this.draft.items.push(item);
    const photo = this.draft.photos.find((p) => p.id === photoId);
    if (photo?.needsPhotoReview) photo.reviewed = false;
    this.changed({ immediate: true });
    return item;
  }
  async enrich() {
    if (this.enriching || this.saving) return;
    const draftId = this.draft.id;
    const controller = new AbortController();
    this.enriching = true;
    this.enrichMessage = "Looking up film details… You can keep reviewing.";
    this.enrichController = controller;
    this.emit();
    const items = this.draft.items.filter((i) => i.include && i.title.trim() && !isItemSaved(i) && !i.matched);
    const stillCurrent = () => !this.disposed && this.draft.id === draftId && !controller.signal.aborted;
    let failures = 0;
    try {
      for (let offset = 0; offset < items.length && stillCurrent(); offset += 25) {
        const chunk = items.slice(offset, offset + 25).map((item) => ({ item, title: item.title, year: item.year }));
        try {
          const { results } = await this.client.enrich(chunk.map(({ title, year }) => ({ title, year })), { signal: controller.signal, expectedToken: this.expectedToken });
          if (!stillCurrent()) break;
          chunk.forEach(({ item, title }, index) => {
            const hit = results?.[index];
            if (!hit?.matched || item.title !== title || isItemSaved(item)) return;
            for (const field of ["director", "actors", "genre", "runtime", "rated", "plot", "imdbRating", "imdbId", "posterUrl"]) if (hit[field]) item[field] = hit[field];
            item.year ||= hit.year;
            item.matched = true;
          });
        } catch {
          if (!stillCurrent()) break;
          failures += chunk.length;
        }
        this.changed();
      }
    } finally {
      // A cleared batch may already have started a new lookup; never change its state.
      if (this.enrichController === controller) {
        this.enriching = false;
        this.enrichController = null;
        if (stillCurrent()) {
          this.enrichMessage = failures ? "Some film details were unavailable. Your titles are ready to save without them." : "Film details updated where a match was found.";
          this.changed({ immediate: true });
        }
      }
    }
  }

  async save(onCreated = () => {}) {
    if (this.saving) return { saved: 0 };
    const chosen = this.draft.items.filter((i) => i.include !== false && !isItemSaved(i));
    if (!chosen.length) throw new Error("Choose at least one tape to save.");
    if (chosen.some(requiresReview)) throw new Error("Confirm or exclude the flagged titles before saving.");
    if (this.draft.photos.some(requiresPhotoReview)) throw new Error("Check the photos with count differences and confirm every physical tape is accounted for.");
    this.saving = true;
    this.saveError = "";
    this.saveProgress = { done: 0, total: chosen.length };
    this.emit();
    let saved = 0;
    try {
      // Persist stable IDs BEFORE sending. A lost response can be retried safely.
      if (!await this.persist()) throw new Error("Your draft could not be saved on this device. Free some device storage and retry; nothing has been sent.");
      if (this.draft.destination === "scout") {
        let savedList;
        for (let offset = 0; offset < chosen.length && !this.disposed; offset += 100) {
          const chunk = chosen.slice(offset, offset + 100);
          const { list } = await this.client.createScout({
            clientId: this.draft.id,
            name: this.draft.scoutName?.trim() || "Store visit",
            items: chunk.map((item) => ({ ...item, location: this.draft.location || "", pricePaid: item.pricePaid ?? this.draft.pricePaid ?? null, priceAsking: item.priceAsking ?? this.draft.priceAsking ?? null })),
            photos: this.draft.photos.map(({ id, name }) => ({ id, name })),
          }, { expectedToken: this.expectedToken });
          if (this.disposed) break;
          savedList = list;
          const returnedItems = new Map((list.items || []).map((item) => [item.clientId, item]));
          for (const item of chunk) if (returnedItems.has(item.clientId)) { Object.assign(item, returnedItems.get(item.clientId), { scoutSavedId: list.id }); saved++; }
          this.draft.scoutListId = list.id;
          this.saveProgress.done = saved;
          await this.changed({ immediate: true });
          if (chunk.some((item) => !item.scoutSavedId)) throw new Error("Some scout titles were not saved. Retry to finish this list.");
        }
        return { saved, scout: true, list: savedList };
      }
      for (let offset = 0; offset < chosen.length; offset += 100) {
        if (this.disposed) break;
        const chunk = chosen.slice(offset, offset + 100);
        const result = await this.client.createTapes(chunk.map((item) => tapePayload(item, this.draft)), { expectedToken: this.expectedToken });
        if (this.disposed) break;
        const returned = new Map((result.tapes || []).map((tape) => [tape.clientId, tape]));
        for (const item of chunk) {
          const tape = returned.get(item.clientId);
          if (tape) { Object.assign(item, tape, { savedId: tape.id }); saved++; }
        }
        onCreated(result.tapes || []);
        this.saveProgress.done = saved;
        await this.changed({ immediate: true });
        if (result.failedCount || returned.size < chunk.length) {
          throw new Error(`${saved} saved. Some tapes could not be saved; retry to finish without creating extra copies.`);
        }
      }
      return { saved };
    } catch (error) {
      this.saveError = `${error.message || "Saving was interrupted."} Your remaining selections are kept for retry.`;
      throw error;
    } finally {
      this.saving = false;
      this.changed({ immediate: true });
    }
  }
  clear({ destination } = {}) {
    if (this.saving || this.preparing) return;
    this.enrichController?.abort();
    this.enrichController = null;
    this.enriching = false;
    this.pause();
    this.draft = { userId: this.draft.userId, id: this.id(), photos: [], items: [], mode: this.draft.mode, destination: ["collection", "scout"].includes(destination) ? destination : this.draft.destination || "collection", scoutName: "", paused: true, location: "", createdAt: Date.now() };
    this.saveError = "";
    this.enrichMessage = "";
    this.changed({ immediate: true });
  }
}

async function lockDraft(userId) {
  if (!globalThis.navigator?.locks) return () => {};
  return new Promise((resolve, reject) => {
    navigator.locks.request(`vhs-scan:${userId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error("This account’s scan draft is open in another tab. Close that tab or sign out there, then try again here.")); return; }
      await new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

export async function openScanSession(userId) {
  if (!userId) throw new Error("Sign in to start a scan.");
  if (current?.draft.userId === userId && !current.disposed) return current;
  if (opening?.userId === userId) return opening.promise;
  disposeScanSession();
  const ticket = generation;
  let releaseLock;
  const promise = (async () => {
    releaseLock = await lockDraft(userId);
    let saved = null;
    let storageError = "";
    try { saved = await draftStore.load(userId); }
    catch { storageError = "Draft storage is unavailable. Keep this tab open and free device storage before saving."; }
    if (ticket !== generation) throw new Error("Scan session changed.");
    current = new ScanSession(userId, saved);
    current.releaseLock = releaseLock;
    current.storageError = storageError;
    opening = null;
    return current;
  })().catch((error) => {
    releaseLock?.();
    if (ticket === generation) opening = null;
    throw error;
  });
  opening = { userId, promise };
  return promise;
}

export function pauseScanSession() { current?.pause(); }
export function disposeScanSession() { generation++; current?.dispose(); current = null; opening = null; }
export function getScanSummary() { return sessionSummary(current?.draft); }

// Flush recent field edits when the browser backgrounds or leaves this document.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => current?.pause());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") current?.persist(); });
}
