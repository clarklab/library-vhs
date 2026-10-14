import test from "node:test";
import assert from "node:assert/strict";
import { ScanSession, duplicateWarnings, requiresReview, requiresPhotoReview, sessionSummary, tapePayload } from "../public/js/scan-session.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail("Condition did not settle"); }
const tape = (title = "Alien", patch = {}) => ({ clientId: title, title, year: 1979, format: "VHS", include: true, confidence: "high", needsReview: false, ...patch });
const response = (title = "Alien", patch = {}) => ({ tapes: [tape(title)], verification: { status: "matched", countedCount: 1, listedCount: 1, uncertainCount: 0 }, ...patch });
function fixture(client = {}, saved) {
  let counter = 0;
  const writes = [];
  const session = new ScanSession("user-a", saved, { client, id: () => `id-${++counter}`, storage: { put: async (draft) => writes.push(structuredClone(draft)) }, resize: async () => "data:image/jpeg;base64,test" });
  return { session, writes };
}
function photos(session, n) { session.draft.photos = Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, name: `${i}.jpg`, status: "queued", image: "data:image/jpeg;base64,test" })); }

test("image preparation is sequential, caps a batch at ten, and removal cannot strand the preparation counter", async () => {
  const { session } = fixture();
  const first = deferred();
  let active = 0, peak = 0, calls = 0;
  session.resize = async () => { active++; peak = Math.max(peak, active); if (++calls === 1) await first.promise; active--; return "photo"; };
  const result = session.addFiles(Array.from({ length: 12 }, (_, i) => ({ name: `${i}.jpg` })));
  await tick();
  session.removePhoto(session.draft.photos[1].id);
  first.resolve();
  await session.prepareChain;
  assert.equal(result.added, 10);
  assert.equal(result.skipped, 2);
  assert.equal(peak, 1);
  assert.equal(session.preparing, 0);
  assert.equal(session.draft.photos.length, 9);
  session.clear();
  assert.equal(session.draft.photos.length, 0);
  session.dispose();
});

test("photo queue never exceeds two in-flight workers and completes incrementally", async () => {
  const jobs = [];
  const { session } = fixture({ scanPhoto: (_image, opts) => { const job = deferred(); jobs.push({ ...job, opts }); return job.promise; } });
  photos(session, 5);
  session.resume();
  assert.equal(jobs.length, 2);
  jobs[0].resolve(response("First"));
  await until(() => jobs.length === 3);
  assert.equal(session.draft.items.length, 1);
  assert.equal(session.controllers.size, 2);
  jobs[1].resolve(response("Second"));
  await until(() => jobs.length === 4);
  jobs[2].resolve(response("Third"));
  await until(() => jobs.length === 5);
  jobs[3].resolve(response("Fourth")); jobs[4].resolve(response("Fifth"));
  await until(() => session.controllers.size === 0);
  assert.equal(session.draft.items.length, 5);
  assert.equal(sessionSummary(session.draft).completed, 5);
  session.dispose();
});

test("pause aborts active requests and keeps work queued; resume starts fresh requests", async () => {
  let calls = 0;
  const { session } = fixture({ scanPhoto: (_image, { signal }) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("paused", "AbortError")))); } });
  photos(session, 3);
  session.resume();
  session.pause();
  await until(() => session.controllers.size === 0);
  assert.equal(calls, 2);
  assert.equal(session.draft.photos.every((photo) => photo.status === "queued"), true);
  session.resume();
  assert.equal(calls, 4);
  session.dispose();
});

test("restoring an interrupted draft preserves edits and marks in-flight work resumable", () => {
  const saved = { userId: "user-a", id: "batch", paused: false, photos: [{ id: "p", status: "processing", image: "photo" }, { id: "q", status: "preparing" }], items: [tape("Corrected title", { confirmed: true })] };
  const { session } = fixture({}, structuredClone(saved));
  assert.equal(session.draft.paused, true);
  assert.equal(session.draft.photos[0].status, "queued");
  assert.equal(session.draft.photos[1].status, "error");
  assert.equal(session.draft.items[0].title, "Corrected title");
  assert.equal(session.draft.items[0].confirmed, true);
  session.dispose();
});

test("mismatches trigger one stronger reading only and unresolved coverage remains a save gate", async () => {
  const requests = [];
  const mismatch = response("Alien", { needsVerification: true, verification: { status: "mismatch", countedCount: 2, listedCount: 1, uncertainCount: 0 } });
  const { session } = fixture({ scanPhoto: async (_image, opts) => { requests.push(opts); return mismatch; }, createTapes: async () => assert.fail("Cannot save unresolved coverage") });
  photos(session, 1); session.resume();
  await until(() => session.controllers.size === 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].mode, "thorough");
  assert.equal(requests[1].verificationContext.countedCount, 2);
  assert.equal(requiresPhotoReview(session.draft.photos[0]), true);
  await assert.rejects(session.save(), /count differences/);
  session.addManual("Missing movie", "p-0");
  assert.equal(requiresPhotoReview(session.draft.photos[0]), true, "Adding a row never silently approves photo completeness");
  session.confirmPhoto("p-0", true);
  assert.equal(requiresPhotoReview(session.draft.photos[0]), false);
  session.dispose();
});

test("failed stronger verification keeps the original titles for manual review", async () => {
  let calls = 0;
  const { session } = fixture({ scanPhoto: async () => { if (++calls === 2) throw new Error("Verifier unavailable"); return response("Survives failure", { needsVerification: true }); } });
  photos(session, 1); session.resume();
  await until(() => session.controllers.size === 0);
  assert.equal(session.draft.items[0].title, "Survives failure");
  assert.equal(session.draft.photos[0].status, "complete");
  assert.equal(requiresPhotoReview(session.draft.photos[0]), true);
  assert.match(session.draft.photos[0].verificationError, /first reading is kept/);
  session.dispose();
});

test("uncertain titles and unknown formats need explicit correction or confirmation", () => {
  assert.equal(requiresReview(tape("Alien", { needsReview: true })), true);
  assert.equal(requiresReview(tape("Alien", { needsReview: true, confirmed: true })), false);
  assert.equal(requiresReview(tape("Alien", { format: "unknown", confirmed: true })), true);
  assert.equal(requiresReview(tape("", { confirmed: true })), true);
  assert.equal(requiresReview(tape("Alien", { needsReview: true, include: false })), false);
});

test("possible repeats are warned about without merging physical copies or different formats", () => {
  const a = tape("The Thing", { clientId: "a", year: 1982, photoId: "p1" });
  const b = tape("Thing", { clientId: "b", year: 1982, photoId: "p2" });
  const c = tape("The Thing", { clientId: "c", year: 1982, format: "DVD" });
  const items = [a, b, c];
  const warnings = duplicateWarnings(items, [tape("The Thing", { year: 1982 })]);
  assert.deepEqual(warnings.get("a"), { batch: 1, library: 1 });
  assert.equal(warnings.has("c"), false);
  assert.equal(items.length, 3);
  assert.equal(items.every((item) => item.include), true);
});

test("save is chunked at 100, retries use stable IDs, and completed chunks are not resent", async () => {
  const requests = [];
  let fail = true;
  const { session, writes } = fixture({ createTapes: async (items) => { requests.push(structuredClone(items)); if (requests.length === 2 && fail) throw new Error("Lost connection"); return { tapes: items.map((item) => ({ ...item, id: `stored-${item.clientId}` })), failedCount: 0 }; } });
  session.draft.items = Array.from({ length: 215 }, (_, index) => tape(`Movie ${index}`, { clientId: `stable-${index}` }));
  await assert.rejects(session.save(), /Lost connection/);
  assert.equal(sessionSummary(session.draft).saved, 100);
  assert.equal(writes.some((draft) => draft.items[0].clientId === "stable-0"), true);
  fail = false;
  const result = await session.save();
  assert.equal(result.saved, 115);
  assert.deepEqual(requests.map((items) => items.length), [100, 100, 100, 15]);
  assert.equal(requests[1][0].clientId, requests[2][0].clientId);
  assert.equal(sessionSummary(session.draft).saved, 215);
  session.dispose();
});

test("partial chunk success reconciles only returned client IDs", async () => {
  const sent = [];
  const { session } = fixture({ createTapes: async (items) => { sent.push(items.map((i) => i.clientId)); return sent.length === 1 ? { tapes: [{ ...items[1], id: "saved-b" }], failedCount: 1 } : { tapes: items.map((i) => ({ ...i, id: "saved-a" })), failedCount: 0 }; } });
  session.draft.items = [tape("A", { clientId: "a" }), tape("B", { clientId: "b" })];
  await assert.rejects(session.save(), /Some tapes/);
  assert.equal(session.draft.items[0].savedId, undefined);
  assert.equal(session.draft.items[1].savedId, "saved-b");
  await session.save();
  assert.deepEqual(sent, [["a", "b"], ["a"]]);
  session.dispose();
});

test("optional enrichment failure leaves the reviewed title saveable", async () => {
  const { session } = fixture({ enrich: async () => { throw new Error("Metadata unavailable"); }, createTapes: async (items) => ({ tapes: items.map((i) => ({ ...i, id: "saved" })) }) });
  session.draft.items = [tape()];
  await session.enrich();
  assert.match(session.enrichMessage, /ready to save/);
  assert.equal((await session.save()).saved, 1);
  session.dispose();
});

test("editing a recognized title removes metadata for the previous film", () => {
  const { session } = fixture();
  session.draft.items = [tape("Wrong film", { clientId: "a", posterUrl: "wrong-poster", director: "Wrong director", matched: true })];
  session.updateItem("a", { title: "Correct film" });
  assert.equal(session.draft.items[0].posterUrl, undefined);
  assert.equal(session.draft.items[0].director, undefined);
  assert.equal(session.draft.items[0].matched, false);
  session.dispose();
});

test("scouting saves a separate idempotent list in chunks and never adds owned tapes", async () => {
  const requests = [], stored = [];
  const { session } = fixture({ createScout: async (payload) => { requests.push(payload); stored.push(...payload.items); return { list: { id: "scout-1", items: stored } }; }, createTapes: async () => assert.fail("Scout items must not enter collection") });
  session.draft.destination = "scout";
  session.draft.scoutName = "Record store";
  session.draft.items = Array.from({ length: 123 }, (_, index) => tape(`Find ${index}`, { clientId: `find-${index}` }));
  const result = await session.save(() => assert.fail("Scout save must not update owned library"));
  assert.equal(result.scout, true);
  assert.equal(result.saved, 123);
  assert.deepEqual(requests.map((r) => r.items.length), [100, 23]);
  assert.equal(requests[0].clientId, requests[1].clientId);
  assert.equal(session.draft.items[0].savedId, undefined);
  assert.equal(session.draft.items[0].scoutSavedId, "scout-1");
  assert.equal(sessionSummary(session.draft).saved, 123);
  session.dispose();
});

test("collection payload preserves the reviewed media format", () => {
  assert.equal(tapePayload(tape("Album", { format: "CD" }), {}).format, "CD");
});

test("pausing and reloading during verification retains the first pass and never repeats a paid reading", async () => {
  let calls = 0;
  const { session, writes } = fixture({ scanPhoto: async (_image, { signal }) => {
    if (++calls === 1) return response("First pass retained", { needsVerification: true });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("paused", "AbortError"))));
  } });
  photos(session, 1); session.resume();
  await until(() => calls === 2);
  assert.equal(writes.some((draft) => draft.photos[0].initialResult?.tapes[0].title === "First pass retained"), true);
  session.pause();
  await until(() => session.controllers.size === 0);
  const saved = structuredClone(session.draft);
  session.dispose();
  const recovered = fixture({ scanPhoto: async () => assert.fail("Recovery must reuse the first pass") }, saved).session;
  recovered.resume();
  await until(() => recovered.controllers.size === 0);
  assert.equal(recovered.draft.items[0].title, "First pass retained");
  assert.equal(requiresPhotoReview(recovered.draft.photos[0]), true);
  assert.equal(calls, 2);
  recovered.dispose();
});

test("device storage failure blocks save before a request can commit without durable retry IDs", async () => {
  const { session } = fixture({ createTapes: async () => assert.fail("No request allowed before stable IDs are persisted") });
  session.storage.put = async () => { throw new Error("Quota exceeded"); };
  session.draft.items = [tape()];
  await assert.rejects(session.save(), /nothing has been sent/);
  assert.equal(sessionSummary(session.draft).saved, 0);
  session.dispose();
});

test("session requests carry the account token pinned when the draft opens", async () => {
  const opts = [];
  const session = new ScanSession("user-a", null, { expectedToken: "original-account", storage: { put: async () => {} }, id: () => "id", client: {
    scanPhoto: async (_image, options) => { opts.push(options); return response(); },
    enrich: async (_items, options) => { opts.push(options); return { results: [] }; },
    createTapes: async (items, options) => { opts.push(options); return { tapes: items.map((i) => ({ ...i, id: "saved" })) }; },
  } });
  photos(session, 1); session.resume();
  await until(() => session.controllers.size === 0);
  await session.enrich(); await session.save();
  assert.equal(opts.length, 3);
  assert.equal(opts.every((options) => options.expectedToken === "original-account"), true);
  session.dispose();
});

test("starting a new batch cancels old enrichment and stale results cannot affect the new lookup", async () => {
  const requests = [];
  const { session } = fixture({ enrich: (_items, options) => { const job = deferred(); requests.push({ ...job, options }); return job.promise; } });
  session.draft.items = Array.from({ length: 30 }, (_, i) => tape(`Old movie ${i}`));
  const oldLookup = session.enrich();
  assert.equal(requests.length, 1);
  session.clear();
  assert.equal(requests[0].options.signal.aborted, true);
  session.draft.items = [tape("New movie")];
  const newLookup = session.enrich();
  assert.equal(requests.length, 2);
  requests[0].resolve({ results: [{ matched: true, director: "Old director" }] });
  await oldLookup;
  assert.equal(requests.length, 2, "No more old-batch chunks are requested");
  assert.equal(session.enriching, true, "The new lookup retains its state");
  assert.equal(session.draft.items[0].director, undefined);
  requests[1].resolve({ results: [{ matched: true, director: "New director" }] });
  await newLookup;
  assert.equal(session.enriching, false);
  assert.equal(session.draft.items[0].director, "New director");
  session.dispose();
});

test("an explicit new batch honors its requested destination without changing the existing draft beforehand", async () => {
  const { session, writes } = fixture();
  session.draft.destination = "collection";
  session.draft.items = [tape("Saved tape", { savedId: "owned-tape" })];
  const oldBatchId = session.draft.id;
  const requestedDestination = "scout";
  assert.equal(session.draft.destination, "collection");
  assert.equal(session.draft.items.length, 1);
  session.clear({ destination: requestedDestination });
  await session.persistChain;
  assert.equal(session.draft.destination, "scout");
  assert.notEqual(session.draft.id, oldBatchId);
  assert.equal(session.draft.items.length, 0);
  assert.equal(writes.at(-1).destination, "scout");
  session.clear({ destination: "invalid-destination" });
  assert.equal(session.draft.destination, "scout");
  session.dispose();
});
