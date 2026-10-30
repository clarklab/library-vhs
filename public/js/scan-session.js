// Durable, account-scoped photo batches. No DOM dependency: queue and save logic are testable.
import { api, getToken, SCAN_REQUEST_TIMEOUT_MS } from "./api.js";
import { resizeImage } from "./util.js";

export const MAX_PHOTOS = 10;
export const SCAN_CONCURRENCY = 2;
export const PRICING_CONCURRENCY = 2;
export const BACKGROUND_SCAN_TIMEOUT_MS = 8 * 60 * 1000;
const newId = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const pendingStatuses = new Set(["queued", "processing", "preparing"]);
const timestamp = (value) => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function waitForPoll(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Checking paused", "AbortError")); return; }
    const aborted = () => { clearTimeout(timer); reject(new DOMException("Checking paused", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
function jobError(value, fallback = "The background scan could not finish. Try again.") {
  const detail = value && typeof value === "object" ? value : {};
  return Object.assign(new Error(errorText(detail.error || detail.message) || fallback), {
    status: Number.isFinite(detail.status) ? detail.status : null,
    code: detail.code || "SCAN_JOB_FAILED", retryable: detail.retryable !== false,
    retryAfterMs: detail.retryAfterMs || 0, requestId: detail.requestId || "",
    diagnostics: detail.errorDetails && typeof detail.errorDetails === "object" ? detail.errorDetails : null,
    details: typeof detail.errorDetails === "string" ? detail.errorDetails : "",
  });
}
const errorText = (value, length = 600) => typeof value === "string" ? value.slice(0, length) : "";
function photoFailure(error, stage, now) {
  const status = Number.isFinite(error?.status) ? error.status : null;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, Math.min(86400000, error.retryAfterMs)) : 0;
  return {
    error: errorText(error?.message) || "This photo could not be read. Try again.",
    errorCode: errorText(error?.code, 100) || (stage === "preparing" ? "IMAGE_PREPARATION_FAILED" : "SCAN_FAILED"),
    errorStatus: status,
    retryable: stage !== "preparing" && (typeof error?.retryable === "boolean" ? error.retryable : status === null || status === 0 || [408, 425, 429].includes(status) || status >= 500),
    retryAfterMs, retryAfter: retryAfterMs ? now + retryAfterMs : 0,
    requestId: errorText(error?.requestId, 160), errorDetails: errorText(error?.details),
    errorDiagnostics: error?.diagnostics && typeof error.diagnostics === "object" ? clone(error.diagnostics) : null,
    errorStage: stage, failedAt: now,
  };
}
function assertScanResponse(response) {
  if (!response || !Array.isArray(response.tapes) || response.tapes.some((tape) => !tape || typeof tape.title !== "string")) {
    throw Object.assign(new Error("The scanner returned an incomplete reading. Your photo is kept; try again."), { status: 502, code: "INVALID_SCAN_RESPONSE", retryable: true });
  }
  return response;
}

export function canRetryAfterServiceUpdate(photo) {
  return Boolean(photo?.status === "error" && photo.image && photo.retryable === false && ([401, 403, 404].includes(photo.errorStatus) || ["AI_CONFIGURATION", "AI_UNAVAILABLE", "ACCOUNT_CHANGED", "AUTH_REQUIRED"].includes(photo.errorCode)));
}

export function canRetryPhoto(photo, now = Date.now(), { afterServiceUpdate = false } = {}) {
  return Boolean(photo?.status === "error" && photo.image && (photo.retryable !== false || (afterServiceUpdate && canRetryAfterServiceUpdate(photo))) && (!photo.retryAfter || photo.retryAfter <= now));
}
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

export function normalizeMarker(marker) {
  return marker && typeof marker.x === "number" && Number.isFinite(marker.x) && marker.x >= 0 && marker.x <= 1 && typeof marker.y === "number" && Number.isFinite(marker.y) && marker.y >= 0 && marker.y <= 1 ? { x: marker.x, y: marker.y } : null;
}

const priceIdentityFields = ["title", "year", "format", "edition", "artist", "condition", "sealed", "packaging", "barcode"];
export function estimateSubject(item) {
  return Object.fromEntries(priceIdentityFields.map((field) => [field, item[field] ?? (field === "year" || field === "sealed" ? null : "")]));
}
const pricingFingerprint = (item) => JSON.stringify(estimateSubject(item));
export function canPriceItem(item) {
  return item.include !== false && !isItemSaved(item) && typeof item.title === "string" && Boolean(item.title.trim()) && !/^(unknown|unreadable|unidentified|untitled)(\b|$)/i.test(item.title.trim()) && ["VHS", "DVD", "CD", "Blu-ray"].includes(item.format);
}

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

export function photoCountMismatch(photo, items) {
  const counted = photo?.verification?.countedCount;
  return photo?.status === "complete" && Number.isInteger(counted) && Array.isArray(items) && counted !== items.filter((item) => item.photoId === photo.id).length;
}

export function requiresPhotoReview(photo, items) {
  return photo.status === "complete" && (photo.needsPhotoReview || photoCountMismatch(photo, items)) && !photo.reviewed;
}

export function sessionSummary(draft) {
  if (!draft) return { photos: 0, completed: 0, pending: 0, preparing: 0, processing: 0, queued: 0, errors: 0, retryableErrors: 0, blockedErrors: 0, waitingErrors: 0, tapes: 0, needsReview: 0, photoReviews: 0, saved: 0, paused: true };
  const failed = draft.photos.filter((photo) => photo.status === "error");
  return {
    photos: draft.photos.length,
    completed: draft.photos.filter((p) => p.status === "complete").length,
    pending: draft.photos.filter((p) => pendingStatuses.has(p.status)).length,
    preparing: draft.photos.filter((p) => p.status === "preparing").length,
    processing: draft.photos.filter((p) => p.status === "processing").length,
    queued: draft.photos.filter((p) => p.status === "queued").length,
    errors: failed.length,
    retryableErrors: failed.filter((photo) => canRetryPhoto(photo)).length,
    blockedErrors: failed.filter((photo) => !photo.image || photo.retryable === false).length,
    waitingErrors: failed.filter((photo) => photo.image && photo.retryable !== false && photo.retryAfter > Date.now()).length,
    tapes: draft.items.filter((i) => i.include !== false && !isItemSaved(i)).length,
    needsReview: draft.items.filter(requiresReview).length,
    photoReviews: draft.photos.filter((photo) => requiresPhotoReview(photo, draft.items)).length,
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
  if (item.estimate) { payload.estimate = item.estimate; payload.estimateFor = item.estimateFor || estimateSubject(item); }
  return payload;
}

export class ScanSession {
  constructor(userId, saved, { client = api, storage = draftStore, resize = resizeImage, id = newId, now = Date.now, transport = "background", wait = waitForPoll, expectedToken = typeof localStorage === "undefined" ? undefined : getToken() } = {}) {
    this.client = client;
    this.expectedToken = expectedToken;
    this.storage = storage;
    this.resize = resize;
    this.id = id;
    this.now = now;
    this.transport = transport;
    this.waitForPoll = wait;
    this.draft = saved || { userId, id: id(), photos: [], items: [], mode: "fast", destination: "collection", scoutName: "", paused: true, location: "", createdAt: Date.now() };
    this.draft.paused = true;
    this.draft.saveDestination ||= this.draft.items.some((item) => item.scoutSavedId) ? "scout" : this.draft.items.some((item) => item.savedId) ? "collection" : undefined;
    this.draft.items.forEach((item) => {
      item.marker = normalizeMarker(item.marker);
      if (["queued", "loading"].includes(item.pricingStatus)) item.pricingStatus = "paused";
      else item.pricingStatus ||= item.estimate ? "complete" : "idle";
      item.pricingError ||= "";
      if (item.estimate && !item.estimateFor) item.estimateFor = estimateSubject(item);
    });
    this.draft.photos.forEach((photo) => {
      if (photo.status === "processing") { photo.status = "queued"; photo.stage = "paused"; photo.pausedAt = now(); }
      if (!photo.image && photo.status !== "preparing") {
        photo.status = "error";
        Object.assign(photo, photoFailure({ message: "This photo is no longer on this device. Remove it and choose it again.", code: "PHOTO_MISSING", retryable: false }, "preparing", now()));
      }
      if (photo.status === "preparing") {
        photo.status = "error";
        Object.assign(photo, photoFailure({ message: "Photo preparation was interrupted. Remove it and choose it again.", code: "PREPARATION_INTERRUPTED", retryable: false }, "preparing", now()));
      }
      if (photo.status === "error") photo.stage = "error";
      photo.stage ||= photo.status;
      photo.requestTimeoutMs ||= SCAN_REQUEST_TIMEOUT_MS;
    });
    this.listeners = new Set();
    this.controllers = new Map();
    this.pricingControllers = new Map();
    this.pricingPaused = true;
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
    if (this.disposed || this.saving || !this.accountMatches()) return { added: 0, skipped: files.length };
    const room = MAX_PHOTOS - this.draft.photos.length;
    const accepted = Array.from(files).slice(0, room);
    for (const file of accepted) {
      const photo = { id: this.id(), name: file.name || "Camera photo", status: "preparing", stage: "preparing", addedAt: this.now(), stageStartedAt: this.now(), attemptCount: 0, requestTimeoutMs: SCAN_REQUEST_TIMEOUT_MS, image: "", error: "", notes: "", warnings: [] };
      this.draft.photos.push(photo);
      this.preparing++;
      this.prepareChain = this.prepareChain.then(async () => {
        try {
          if (this.disposed || !this.draft.photos.includes(photo)) return;
          photo.preparationStartedAt = this.now();
          photo.stageStartedAt = photo.preparationStartedAt;
          this.emit();
          photo.image = await this.resize(file, 2400, 0.88);
          if (this.disposed || !this.draft.photos.includes(photo)) return;
          photo.status = "queued";
          photo.stage = "queued";
          photo.queuedAt = photo.stageStartedAt = this.now();
        } catch (error) {
          if (this.disposed || !this.draft.photos.includes(photo)) return;
          photo.status = "error";
          Object.assign(photo, photoFailure(error, "preparing", this.now()));
          photo.stage = "error"; photo.finishedAt = this.now();
        } finally {
          this.preparing = Math.max(0, this.preparing - 1);
          if (!this.disposed) { await this.changed({ immediate: true }); this.pump(); }
        }
      });
    }
    this.changed();
    return { added: accepted.length, skipped: Math.max(0, files.length - accepted.length) };
  }

  resume() { if (this.disposed || this.saving || !this.accountMatches()) return; this.draft.paused = false; this.draft.pauseReason = ""; this.changed(); this.pump(); }
  pause({ reason = "" } = {}) {
    this.draft.paused = true;
    this.draft.pauseReason = reason;
    this.pausePricing({ notify: false });
    for (const controller of this.controllers.values()) controller.abort();
    this.draft.photos.forEach((photo) => { if (photo.status === "processing") { photo.status = "queued"; photo.stage = "paused"; photo.pausedAt = this.now(); } });
    this.changed({ immediate: true });
  }
  dispose() { this.pause(); this.disposed = true; this.listeners.clear(); this.enrichController?.abort(); this.persistChain.finally(() => this.releaseLock?.()); }
  pump() {
    if (this.disposed || this.draft.paused || this.saving || !this.accountMatches()) return;
    while (this.controllers.size < SCAN_CONCURRENCY) {
      const photo = this.draft.photos.find((p) => p.status === "queued" && p.image && !this.controllers.has(p.id));
      if (!photo) return;
      this.runPhoto(photo);
    }
  }
  async readBackgroundPhoto(photo, signal) {
    photo.background = true;
    photo.requestTimeoutMs = BACKGROUND_SCAN_TIMEOUT_MS;
    photo.jobCheckStartedAt = this.now();
    const active = () => !this.disposed && !signal.aborted && this.accountMatches() && this.draft.photos.includes(photo);
    if (!photo.jobClientId) {
      photo.jobClientId = this.id();
      photo.jobMode = this.draft.mode;
      photo.jobCreatedAt = this.now();
      photo.jobStatus = "queued";
    }
    // A lost create response must still have a durable key for the same job.
    if (!await this.persist()) throw Object.assign(new Error("This device could not save the photo’s job ID. Free some storage and retry; no new scan has been sent."), { code: "DRAFT_STORAGE_UNAVAILABLE", retryable: true });
    if (!active()) throw new DOMException("Checking paused", "AbortError");
    const create = () => this.client.createScanJob({ image: photo.image, clientId: photo.jobClientId, sourceId: photo.id, mode: photo.jobMode || this.draft.mode }, { signal, expectedToken: this.expectedToken });
    let envelope = !photo.jobId || photo.redispatchRequested ? await create() : await this.client.getScanJob(photo.jobId, { signal, expectedToken: this.expectedToken });
    delete photo.redispatchRequested;
    while (active()) {
      const job = envelope?.job;
      if (!job?.id || !["queued", "running", "complete", "completed", "failed", "expired"].includes(job.status)) throw Object.assign(new Error("The server returned an incomplete scan update. Your photo is kept; try checking again."), { code: "INVALID_JOB_RESPONSE", status: 502, retryable: true });
      photo.jobId = job.id;
      photo.jobStatus = job.status;
      photo.jobCreatedAt = timestamp(job.createdAt) ?? photo.jobCreatedAt;
      photo.jobUpdatedAt = timestamp(job.updatedAt) ?? this.now();
      photo.startedAt = timestamp(job.startedAt) ?? photo.jobCreatedAt ?? photo.startedAt;
      photo.jobDeadlineAt = timestamp(job.deadlineAt) ?? timestamp(job.leaseExpiresAt) ?? null;
      photo.jobExpiresAt = timestamp(job.expiresAt);
      photo.dispatchError = job.dispatchError || null;
      if (job.progress && typeof job.progress === "object") {
        photo.jobProgress = {
          countFinished: job.progress.countFinished === true,
          ...(Number.isInteger(job.progress.independentCount) && job.progress.independentCount >= 0 && job.progress.independentCount <= 1000 ? { independentCount: job.progress.independentCount } : {}),
        };
      }
      const stage = ["reading", "counting", "verifying"].includes(job.stage) ? job.stage : job.status === "queued" ? "queued" : "reading";
      if (photo.stage !== stage) { photo.stage = stage; photo.stageStartedAt = this.now(); }
      if (job.result?.tapes) photo.initialResult = assertScanResponse(job.result);
      await this.changed({ immediate: true });
      if (!active()) throw new DOMException("Checking paused", "AbortError");
      if (["complete", "completed"].includes(job.status)) return assertScanResponse({ ...job.result, ...(!job.result?.verificationFailure && job.verificationFailure ? { verificationFailure: job.verificationFailure } : {}) });
      if (["failed", "expired"].includes(job.status)) {
        if (photo.initialResult?.tapes) return { ...photo.initialResult, needsVerification: true, verificationFailure: job.error || { error: "The follow-up check could not finish.", code: "SCAN_JOB_INTERRUPTED", retryable: true } };
        throw jobError(job.error, job.status === "expired" ? "The background scan expired. Retry this photo to start a new scan." : undefined);
      }
      const queuedFor = this.now() - Math.max(photo.jobCreatedAt, photo.jobCheckStartedAt);
      if (job.status === "queued" && queuedFor >= 30000 && !photo.jobDispatchRetried) {
        photo.jobDispatchRetried = true;
        await this.changed({ immediate: true });
        envelope = await create();
        continue;
      }
      if (job.status === "queued" && queuedFor >= 60000) throw Object.assign(new Error("The background scanner has not started yet. Try checking again to reconnect this same job."), { code: "SCAN_JOB_QUEUED", status: 503, retryable: true });
      const deadline = photo.jobDeadlineAt || photo.jobCreatedAt + BACKGROUND_SCAN_TIMEOUT_MS;
      if (this.now() > deadline + 60000) throw Object.assign(new Error("This scan is taking longer than expected. Your job is kept; check again for its result."), { code: "SCAN_JOB_WAIT_TIMEOUT", status: 408, retryable: true });
      await this.waitForPoll(Math.max(750, Math.min(10000, Number(envelope.pollAfterMs) || 1500)), signal);
      if (!active()) throw new DOMException("Checking paused", "AbortError");
      envelope = await this.client.getScanJob(photo.jobId, { signal, expectedToken: this.expectedToken });
    }
    throw new DOMException("Checking paused", "AbortError");
  }
  async runPhoto(photo) {
    const controller = new AbortController();
    this.controllers.set(photo.id, controller);
    photo.status = "processing";
    photo.stage = this.transport === "background" ? "queued" : "reading";
    photo.startedAt = photo.stageStartedAt = this.now();
    photo.finishedAt = null;
    photo.pausedAt = null;
    photo.attemptCount = (photo.attemptCount || 0) + 1;
    photo.requestTimeoutMs = this.transport === "background" ? BACKGROUND_SCAN_TIMEOUT_MS : SCAN_REQUEST_TIMEOUT_MS;
    photo.error = "";
    for (const field of ["errorCode", "errorStatus", "errorDetails", "errorDiagnostics", "errorStage", "requestId", "retryAfterMs", "retryAfter", "retryable"]) delete photo[field];
    const mode = this.draft.mode;
    this.changed();
    try {
      const background = this.transport === "background";
      const recoveredLegacyReading = background && photo.initialResult && !photo.jobId && !photo.jobClientId;
      let response = background && !recoveredLegacyReading ? await this.readBackgroundPhoto(photo, controller.signal) : photo.initialResult;
      if (response) assertScanResponse(response);
      if (!background && !response) {
        response = assertScanResponse(await this.client.scanPhoto(photo.image, { signal: controller.signal, mode, sourceId: photo.id, expectedToken: this.expectedToken }));
        if (this.disposed || !this.draft.photos.includes(photo)) return;
        photo.initialResult = response;
        photo.initialMode = mode;
        await this.changed({ immediate: true });
      }
      if (this.disposed || controller.signal.aborted || !this.draft.photos.includes(photo)) return;
      photo.verification = response.verification || null;
      photo.verificationError = !background && photo.verificationAttempted && !photo.verified ? "Double-checking was interrupted. Your first reading is kept; check this photo before saving." : "";
      if (recoveredLegacyReading) photo.verificationError = "Your saved first reading was recovered. Check this photo before saving.";
      if (response.verificationFailure) {
        photo.verificationFailure = photoFailure(jobError(response.verificationFailure), "verifying", this.now());
        photo.verificationError = `${photo.verificationFailure.error} Your first reading is kept; check this photo before saving.`;
      }
      // One stronger pass only. Retain the first reading if verification is unavailable.
      if (!background && (photo.initialMode || mode) !== "thorough" && response.needsVerification && !photo.verificationAttempted) {
        photo.verificationAttempted = true;
        photo.stage = "verifying";
        photo.stageStartedAt = this.now();
        await this.changed({ immediate: true });
        try {
          const verified = assertScanResponse(await this.client.scanPhoto(photo.image, {
            signal: controller.signal, mode: "thorough", sourceId: photo.id, expectedToken: this.expectedToken,
            verificationContext: {
              countedCount: response.verification?.countedCount ?? null,
              uncertainCount: response.verification?.uncertainCount ?? 0,
              tapes: response.tapes,
              countPositions: response.verification?.positions,
            },
          }));
          if (Array.isArray(verified?.tapes)) {
            // The verifier may add, remove or reorder rows. sourceIndex is a
            // reading order, not a stable physical ID: never borrow its old pin.
            response = { ...verified, tapes: verified.tapes.map((item) => ({ ...item, ...(Object.hasOwn(item, "marker") ? { marker: normalizeMarker(item.marker) } : {}) })) };
            photo.initialResult = response; photo.verified = true;
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          photo.verificationFailure = photoFailure(error, "verifying", this.now());
          photo.verificationError = `${photo.verificationFailure.error} Your first reading is kept; check this photo before saving.`;
        }
      }
      if (this.disposed || controller.signal.aborted || !this.draft.photos.includes(photo)) return;
      const tapes = Array.isArray(response?.tapes) ? response.tapes : [];
      photo.status = "complete";
      photo.stage = "complete";
      photo.finishedAt = this.now();
      photo.verification = response.verification || null;
      photo.coverage = response.coverage || null;
      photo.needsPhotoReview = Boolean(photo.needsPhotoReview || photo.verificationError || !response.verification || response.verification.status !== "matched" || response.verification.uncertainCount > 0 || photo.coverage?.unplacedCount > 0 || photo.coverage?.overlapCount > 0 || photo.coverage?.independentUnplacedCount > 0 || photo.coverage?.independentOverlapCount > 0 || tapes.some((item) => (Object.hasOwn(item, "marker") && !normalizeMarker(item.marker)) || item.markerIssue === "overlap"));
      photo.reviewed = false;
      photo.notes = response.notes || "";
      photo.warnings = response.warnings || [];
      photo.model = response.model;
      photo.mode = response.mode || photo.jobMode || mode;
      photo.reportedCount = response.reportedCount ?? response.count ?? tapes.length;
      photo.durationMs = response.durationMs;
      photo.requestId = errorText(response.requestId, 160);
      this.draft.items.push(...tapes.map((tape, index) => ({
        ...tape, title: String(tape.title || ""), format: tape.format || "unknown", clientId: this.id(), photoId: photo.id,
        sourceIndex: tape.sourceIndex || index + 1, marker: normalizeMarker(tape.marker), include: true, confirmed: false, pricingStatus: "idle", pricingError: "",
        needsReview: tape.needsReview === true || tape.confidence !== "high" || (Object.hasOwn(tape, "marker") && !normalizeMarker(tape.marker)) || tape.markerIssue === "overlap",
      })));
      // Manual rows can be added while reading. Coverage refers to the final
      // inventory in this draft, including those rows, not only the AI response.
      photo.needsPhotoReview ||= photoCountMismatch(photo, this.draft.items);
      delete photo.initialResult;
      await this.changed({ immediate: true });
    } catch (error) {
      if (this.disposed || !this.draft.photos.includes(photo)) return;
      if (controller.signal.aborted) { photo.status = "queued"; photo.stage = "paused"; photo.pausedAt ||= this.now(); }
      else {
        if (["SCAN_JOB_NOT_FOUND", "JOB_NOT_FOUND"].includes(error.code) && photo.jobId) {
          photo.jobStatus = "expired";
          error.retryable = true;
          error.message = "This saved scan is no longer available. Retry to start a new scan from your photo.";
        }
        photo.status = "error";
        Object.assign(photo, photoFailure(error, photo.stage, this.now()));
        photo.stage = "error"; photo.finishedAt = this.now();
        if ([0, 401, 403, 404, 429, 503].includes(photo.errorStatus) || ["AI_CONFIGURATION", "AI_UNAVAILABLE", "ACCOUNT_CHANGED", "DRAFT_STORAGE_UNAVAILABLE"].includes(photo.errorCode)) this.pause({ reason: photo.error });
      }
      this.changed({ immediate: true });
    } finally {
      this.controllers.delete(photo.id);
      this.emit();
      this.pump();
    }
  }
  retryPhoto(id, options = {}) {
    const photo = this.draft.photos.find((p) => p.id === id);
    if (this.disposed || this.saving || !this.accountMatches() || !canRetryPhoto(photo, this.now(), options)) return false;
    this.prepareJobRetry(photo);
    photo.status = "queued";
    photo.stage = "queued";
    photo.queuedAt = photo.stageStartedAt = this.now();
    this.resume();
    return true;
  }
  retryFailedPhotos() {
    let retried = 0, blocked = 0, waiting = 0;
    if (this.disposed || this.saving || !this.accountMatches()) return { retried, blocked, waiting };
    for (const photo of this.draft.photos.filter((entry) => entry.status === "error")) {
      if (!photo.image || photo.retryable === false) { blocked++; continue; }
      if (!canRetryPhoto(photo, this.now())) { waiting++; continue; }
      this.prepareJobRetry(photo);
      photo.status = "queued"; photo.stage = "queued"; photo.queuedAt = photo.stageStartedAt = this.now(); retried++;
    }
    if (retried) this.resume();
    return { retried, blocked, waiting };
  }
  prepareJobRetry(photo) {
    if (["failed", "expired"].includes(photo.jobStatus)) {
      for (const key of ["jobId", "jobClientId", "jobStatus", "jobMode", "jobCreatedAt", "jobUpdatedAt", "jobDeadlineAt", "jobExpiresAt", "jobDispatchRetried", "jobProgress", "initialResult", "verificationAttempted", "verificationFailure", "verificationError", "verified"]) delete photo[key];
    } else if (photo.jobStatus === "queued" && photo.jobId) photo.redispatchRequested = true;
  }
  removePhoto(id) {
    if (this.saving) return;
    this.controllers.get(id)?.abort();
    for (const item of this.draft.items) if (item.photoId === id && !isItemSaved(item)) this.pricingControllers.get(item.clientId)?.abort();
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
    if (priceIdentityFields.some((field) => Object.hasOwn(patch, field) && patch[field] !== item[field])) this.invalidatePricing(item);
    if (Object.hasOwn(patch, "marker")) patch = { ...patch, marker: normalizeMarker(patch.marker), markerIssue: normalizeMarker(patch.marker) ? null : "unplaced" };
    Object.assign(item, patch);
    if (item.include === false) {
      this.pricingControllers.get(item.clientId)?.abort();
      if (["queued", "loading", "paused"].includes(item.pricingStatus)) item.pricingStatus = item.estimate ? "complete" : "idle";
    }
    if (Object.hasOwn(patch, "include") || Object.hasOwn(patch, "format") || Object.hasOwn(patch, "marker")) {
      const photo = this.draft.photos.find((p) => p.id === item.photoId);
      if (photo) {
        if (Object.hasOwn(patch, "include") || Object.hasOwn(patch, "format") || (Object.hasOwn(patch, "marker") && !item.marker)) photo.needsPhotoReview = true;
        photo.reviewed = false;
      }
    }
    this.changed();
  }
  addManual(title, photoId = "", marker = null) {
    const item = { clientId: this.id(), title: title.trim(), year: null, format: "VHS", photoId, sourceIndex: null, marker: normalizeMarker(marker), markerIssue: normalizeMarker(marker) ? null : "unplaced", include: true, confirmed: true, needsReview: false, confidence: "manual", pricingStatus: "idle", pricingError: "" };
    if (!item.title || this.saving) return;
    this.draft.items.push(item);
    const photo = this.draft.photos.find((p) => p.id === photoId);
    if (photo) { photo.needsPhotoReview = true; photo.reviewed = false; }
    this.changed({ immediate: true });
    return item;
  }
  accountMatches() { return this.expectedToken === undefined || typeof localStorage === "undefined" || getToken() === this.expectedToken; }
  invalidatePricing(item) {
    this.pricingControllers.get(item.clientId)?.abort();
    item.estimate = null;
    delete item.estimateFor;
    item.pricingStatus = "idle";
    item.pricingError = "";
  }
  pricingSummary() {
    const items = this.draft.items.filter(canPriceItem);
    return {
      active: items.filter((item) => item.pricingStatus === "loading").length,
      queued: items.filter((item) => item.pricingStatus === "queued").length,
      completed: items.filter((item) => item.pricingStatus === "complete").length,
      errors: items.filter((item) => item.pricingStatus === "error").length,
      paused: items.filter((item) => item.pricingStatus === "paused").length,
      eligible: items.length,
    };
  }
  priceAll(options = {}) { return this.requestPricing(this.draft.items.map((item) => item.clientId), options); }
  requestPricing(ids, { refresh = false } = {}) {
    if (this.disposed || this.saving || !this.accountMatches()) return { queued: 0, skipped: 0 };
    const selected = new Set(Array.isArray(ids) ? ids : [ids]);
    let queued = 0, skipped = 0;
    for (const item of this.draft.items) {
      if (!selected.has(item.clientId)) continue;
      if (!canPriceItem(item) || ["loading", "queued"].includes(item.pricingStatus) || (!refresh && item.pricingStatus === "complete" && item.estimate)) { skipped++; continue; }
      item.pricingStatus = "queued";
      item.pricingError = "";
      queued++;
    }
    if (queued) { this.pricingPaused = false; this.changed(); this.pumpPricing(); }
    return { queued, skipped };
  }
  pausePricing({ notify = true } = {}) {
    this.pricingPaused = true;
    for (const controller of this.pricingControllers.values()) controller.abort();
    for (const item of this.draft.items) if (["queued", "loading"].includes(item.pricingStatus)) item.pricingStatus = "paused";
    if (notify) this.changed({ immediate: true });
  }
  pumpPricing() {
    if (this.disposed || this.pricingPaused || this.saving || !this.accountMatches()) return;
    while (this.pricingControllers.size < PRICING_CONCURRENCY) {
      const item = this.draft.items.find((candidate) => candidate.pricingStatus === "queued" && canPriceItem(candidate) && !this.pricingControllers.has(candidate.clientId));
      if (!item) return;
      this.runPricing(item);
    }
  }
  async runPricing(item) {
    const controller = new AbortController();
    const draftId = this.draft.id, fingerprint = pricingFingerprint(item), subject = estimateSubject(item);
    this.pricingControllers.set(item.clientId, controller);
    item.pricingStatus = "loading";
    item.pricingError = "";
    this.changed();
    const currentItem = () => !this.disposed && this.accountMatches() && this.draft.id === draftId && this.draft.items.includes(item) && canPriceItem(item) && pricingFingerprint(item) === fingerprint;
    try {
      const estimate = await this.client.valueEstimate(subject, { signal: controller.signal, expectedToken: this.expectedToken });
      if (controller.signal.aborted || !currentItem()) return;
      if (!estimate || typeof estimate !== "object" || typeof estimate.known !== "boolean") throw new Error("The price check returned an incomplete result. Try again.");
      if (estimate.market?.status === "unavailable") {
        if (!item.estimate) { item.estimate = estimate; item.estimateFor = subject; }
        const unavailable = new Error(estimate.summary || "The live price check is unavailable. Try again.");
        unavailable.status = 503;
        throw unavailable;
      }
      item.estimate = estimate;
      item.estimateFor = subject;
      item.pricingStatus = "complete";
      item.pricingError = "";
      await this.changed({ immediate: true });
    } catch (error) {
      if (!currentItem()) return;
      if (controller.signal.aborted) { if (item.pricingStatus === "loading") item.pricingStatus = "paused"; }
      else {
        item.pricingStatus = "error";
        item.pricingError = error.message || "This title’s price check was interrupted. Try again.";
        if ([0, 401, 403, 408, 429, 503, 504].includes(error.status)) this.pausePricing({ notify: false });
      }
      this.changed({ immediate: true });
    } finally {
      if (this.pricingControllers.get(item.clientId) === controller) this.pricingControllers.delete(item.clientId);
      this.emit();
      this.pumpPricing();
    }
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
            if (!item.year && hit.year) { this.invalidatePricing(item); item.year = hit.year; }
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
    if (this.disposed || !this.accountMatches()) throw new Error("Your account changed. Reopen the scan before saving.");
    if (this.draft.saveDestination && this.draft.saveDestination !== this.draft.destination) {
      this.draft.destination = this.draft.saveDestination;
      throw new Error("This batch already started saving to a destination. Retry there, or start a new batch for a different destination.");
    }
    const chosen = this.draft.items.filter((i) => i.include !== false && !isItemSaved(i));
    if (!chosen.length) throw new Error("Choose at least one tape to save.");
    if (chosen.some(requiresReview)) throw new Error("Confirm or exclude the flagged titles before saving.");
    if (this.draft.photos.some((photo) => requiresPhotoReview(photo, this.draft.items))) throw new Error("Check the photos with count differences and confirm every physical tape is accounted for.");
    this.pausePricing({ notify: false });
    this.saving = true;
    this.saveError = "";
    this.saveProgress = { done: 0, total: chosen.length };
    this.emit();
    let saved = 0;
    try {
      // Persist stable IDs BEFORE sending. A lost response can be retried safely.
      const previousDestination = this.draft.saveDestination;
      this.draft.saveDestination = this.draft.destination;
      if (!await this.persist()) {
        this.draft.saveDestination = previousDestination;
        throw new Error("Your draft could not be saved on this device. Free some device storage and retry; nothing has been sent.");
      }
      if (this.draft.destination === "scout") {
        let savedList;
        for (let offset = 0; offset < chosen.length && !this.disposed; offset += 100) {
          const chunk = chosen.slice(offset, offset + 100);
          const { list } = await this.client.createScout({
            clientId: this.draft.id,
            name: this.draft.scoutName?.trim() || "Store visit",
            items: chunk.map((item) => ({
              ...tapePayload(item, this.draft), artist: item.artist || "", photoId: item.photoId || "", sourceIndex: item.sourceIndex ?? null,
              marker: normalizeMarker(item.marker), markerIssue: item.markerIssue || null, visual: item.visual || "", confidence: item.confidence || "manual",
              ...(item.estimate ? { estimate: item.estimate, estimateFor: item.estimateFor || estimateSubject(item) } : {}),
            })),
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
