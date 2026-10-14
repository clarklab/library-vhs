import test from "node:test";
import assert from "node:assert/strict";
import { ScanSession, duplicateWarnings, requiresReview, requiresPhotoReview, photoCountMismatch, sessionSummary, tapePayload } from "../public/js/scan-session.js";

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

const livePrice = (price = 10, patch = {}) => ({ known: true, low: price, high: price + 5, typical: price, source: "live_web_search", currency: "USD", market: { status: "available", basis: "asking", sampleCount: 1, listings: [{ title: "Listing", url: "https://example.com/listing", price, kind: "asking" }] }, ...patch });

test("live price checks are explicit, stay at two concurrent requests, persist incrementally, and skip excluded/unidentified copies", async () => {
  const requests = [];
  const { session, writes } = fixture({ valueEstimate: (subject, options) => { const job = deferred(); requests.push({ ...job, subject, options }); return job.promise; } });
  session.draft.items = [tape("A"),tape("B"),tape("C"),tape("Unknown tape"),tape("Excluded",{include:false}),tape("No format",{format:"unknown"})];
  assert.equal(requests.length,0);
  assert.deepEqual(session.priceAll(),{queued:3,skipped:3});
  assert.equal(requests.length,2); assert.equal(session.pricingSummary().active,2); assert.equal(session.pricingSummary().queued,1);
  requests[0].resolve(livePrice(12)); await until(() => requests.length === 3);
  assert.equal(session.draft.items[0].estimate.typical,12); assert.equal(session.pricingSummary().completed,1);
  requests[1].reject(new Error("Network interrupted")); requests[2].resolve(livePrice(20)); await until(() => session.pricingControllers.size === 0);
  assert.equal(session.pricingSummary().errors,1); assert.equal(session.pricingSummary().completed,2);
  assert.ok(writes.some((draft) => draft.items[0].estimate?.typical === 12));
  assert.deepEqual(session.priceAll(),{queued:1,skipped:5}); assert.equal(requests.length,4);
  requests[3].resolve(livePrice(15)); await until(() => session.pricingControllers.size === 0);
  assert.equal(session.pricingSummary().completed,3); session.dispose();
});

test("correcting a tape cancels its old price check and stale results cannot price the corrected title", async () => {
  const requests = [];
  const { session } = fixture({ valueEstimate: (subject,options) => { const job = deferred(); requests.push({...job,subject,options}); return job.promise; } });
  session.draft.items = [tape("Wrong title",{clientId:"physical-copy",marker:{x:.2,y:.3},estimate:livePrice(99),pricingStatus:"complete"})];
  session.requestPricing("physical-copy",{refresh:true}); session.updateItem("physical-copy",{title:"Correct title"});
  assert.equal(requests[0].options.signal.aborted,true); assert.equal(session.draft.items[0].estimate,null); assert.deepEqual(session.draft.items[0].marker,{x:.2,y:.3});
  session.requestPricing("physical-copy"); requests[0].resolve(livePrice(999)); await until(() => requests.length === 2);
  assert.equal(session.draft.items[0].estimate,null); assert.equal(requests[1].subject.title,"Correct title");
  requests[1].resolve(livePrice(5)); await until(() => session.pricingControllers.size === 0); assert.equal(session.draft.items[0].estimate.typical,5);
  session.updateItem("physical-copy",{edition:"New edition"}); assert.equal(session.draft.items[0].estimate,null); session.dispose();
});

test("route pause persists price progress and reload resumes only through an explicit price action", async () => {
  const requests = [];
  const { session } = fixture({ valueEstimate: (subject,{signal}) => { const job = deferred(); signal.addEventListener("abort",() => job.reject(new DOMException("paused","AbortError"))); requests.push(job); return job.promise; } });
  session.draft.items = [tape("A"),tape("B"),tape("C")]; session.priceAll(); requests[0].resolve(livePrice()); await until(() => requests.length === 3);
  session.pause(); await until(() => session.pricingControllers.size === 0);
  assert.equal(session.draft.items[0].pricingStatus,"complete"); assert.equal(session.draft.items[1].pricingStatus,"paused");
  const stored = structuredClone(session.draft); session.dispose(); let calls = 0;
  const recovered = fixture({ valueEstimate: async () => { calls++; return livePrice(); } },stored).session;
  recovered.resume(); await tick(); assert.equal(calls,0,"Resuming photo reading never spends on pricing automatically");
  assert.deepEqual(recovered.priceAll(),{queued:2,skipped:1}); await until(() => recovered.pricingControllers.size === 0); assert.equal(calls,2); recovered.dispose();
});

test("removing a photo or clearing the batch discards late price results without changing the next batch", async () => {
  const requests = [];
  const { session } = fixture({ valueEstimate: (_subject,options) => { const job = deferred(); requests.push({...job,options}); return job.promise; } });
  photos(session,1); session.draft.items = [tape("Old",{photoId:"p-0"})]; session.priceAll(); session.removePhoto("p-0");
  assert.equal(requests[0].options.signal.aborted,true); requests[0].resolve(livePrice(99)); await until(() => session.pricingControllers.size === 0); assert.equal(session.draft.items.length,0);
  session.draft.items = [tape("Other old")]; session.priceAll(); session.clear(); session.draft.items = [tape("New")]; session.priceAll();
  requests[1].resolve(livePrice(88)); await tick(); assert.equal(session.draft.items[0].estimate,undefined);
  requests[2].resolve(livePrice(3)); await until(() => session.pricingControllers.size === 0); assert.equal(session.draft.items[0].estimate.typical,3); session.dispose();
});

test("pricing carries the pinned account and ignores late results after the account changes", async () => {
  const previous = globalThis.localStorage; let token = "owner-one"; const job = deferred(); let options;
  globalThis.localStorage = {getItem:() => token};
  try {
    const { session } = fixture({valueEstimate:(_subject,opts) => { options = opts; return job.promise; }}); session.draft.items = [tape("A")]; session.priceAll();
    assert.equal(options.expectedToken,"owner-one"); token = "owner-two"; job.resolve(livePrice()); await until(() => session.pricingControllers.size === 0);
    assert.equal(session.draft.items[0].estimate,undefined); assert.equal(session.priceAll().queued,0); session.dispose();
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});

test("spatial markers, independent positions and manual moves survive verification and reload without leaking scan fields into collection payloads", async () => {
  const positions = [{sourceIndex:1,label:"Counted tape",marker:{x:.2,y:.3},markerIssue:null}], options = [];
  const { session } = fixture({scanPhoto:async (_image,opts) => { options.push(opts); return options.length === 1 ? response("First",{tapes:[tape("First",{marker:{x:.2,y:.3},sourceIndex:1})],needsVerification:true,verification:{status:"matched",countedCount:1,listedCount:1,uncertainCount:0,positions}}) : response("Corrected",{tapes:[tape("Corrected",{sourceIndex:1,marker:null})],coverage:{markedCount:0,unplacedCount:1,overlapCount:0},verification:{status:"matched",countedCount:1,listedCount:1,uncertainCount:0,positions}}); }});
  photos(session,1); session.resume(); await until(() => session.controllers.size === 0);
  assert.deepEqual(options[1].verificationContext.countPositions,positions); assert.equal(session.draft.items[0].marker,null,"A verifier’s row order is not a stable physical identity; never borrow an old point"); assert.equal(requiresPhotoReview(session.draft.photos[0]),true);
  const item = session.draft.items[0]; session.updateItem(item.clientId,{marker:{x:.7,y:.8}}); assert.equal(item.markerIssue,null);
  const manual = session.addManual("Missed spine","p-0",{x:.9,y:.4}); assert.deepEqual(manual.marker,{x:.9,y:.4});
  session.updateItem(item.clientId,{marker:{x:2,y:.5}}); assert.equal(item.marker,null); assert.equal(item.markerIssue,"unplaced");
  const saved = structuredClone(session.draft); session.dispose(); const restored = fixture({},saved).session; assert.deepEqual(restored.draft.items[1].marker,{x:.9,y:.4});
  const payload = tapePayload(restored.draft.items[1],restored.draft); assert.equal("marker" in payload,false); assert.equal("pricingStatus" in payload,false); restored.dispose();
});

test("an ambiguous save response locks the chosen destination for safe retries", async () => {
  const { session } = fixture({createTapes:async () => { throw new Error("Response lost"); },createScout:async () => assert.fail("Do not switch destinations after a possible write")}); session.draft.items = [tape()];
  await assert.rejects(session.save(),/Response lost/); assert.equal(session.draft.saveDestination,"collection"); session.draft.destination = "scout";
  await assert.rejects(session.save(),/already started saving/); assert.equal(session.draft.destination,"collection"); session.dispose();
});

test("manual additions, exclusions and missing marker edits reopen photo coverage even after a matched count", async () => {
  const { session } = fixture({scanPhoto:async () => response("Original"),createTapes:async () => assert.fail("Unreviewed changes must not save")}); photos(session,1); session.resume(); await until(() => session.controllers.size === 0);
  const photo = session.draft.photos[0]; assert.equal(requiresPhotoReview(photo),false);
  const added = session.addManual("Missed physical tape",photo.id,{x:.5,y:.5}); assert.equal(requiresPhotoReview(photo),true); await assert.rejects(session.save(),/count differences/);
  session.confirmPhoto(photo.id,true); session.updateItem(added.clientId,{include:false}); assert.equal(requiresPhotoReview(photo),true);
  session.confirmPhoto(photo.id,true); session.updateItem(session.draft.items[0].clientId,{marker:null}); assert.equal(requiresPhotoReview(photo),true); session.dispose();
});

test("a manual title added during reading remains a coverage save gate after the AI finishes", async () => {
  const reading = deferred();
  let saves = 0;
  const { session } = fixture({
    scanPhoto: () => reading.promise,
    createTapes: async (items) => { saves++; return { tapes: items.map((item) => ({ ...item, id: `stored-${item.clientId}` })) }; },
  });
  photos(session, 1);
  session.resume();
  const photo = session.draft.photos[0];
  session.addManual("Manual title", photo.id, { x: .8, y: .8 });
  // A premature check cannot approve titles that have not arrived yet.
  session.confirmPhoto(photo.id, true);
  reading.resolve(response("Detected title", { tapes: [tape("Detected title", { marker: { x: .2, y: .2 } })] }));
  await until(() => session.controllers.size === 0);
  assert.equal(session.draft.items.length, 2);
  assert.equal(photoCountMismatch(photo, session.draft.items), true);
  assert.equal(photo.needsPhotoReview, true);
  assert.equal(photo.reviewed, false);
  assert.equal(sessionSummary(session.draft).photoReviews, 1);
  await assert.rejects(session.save(), /count differences/);
  assert.equal(saves, 0);
  session.confirmPhoto(photo.id, true);
  assert.equal(sessionSummary(session.draft).photoReviews, 0);
  assert.equal((await session.save()).saved, 2);
  session.dispose();
});

test("restored count mismatches gate saving even when an older draft has no coverage flag", async () => {
  const { session } = fixture({ createTapes: async () => assert.fail("Unreviewed restored coverage must not save") }, {
    userId: "user-a", id: "existing-batch", destination: "collection", photos: [{ id: "p", status: "complete", image: "photo", verification: { status: "matched", countedCount: 1 }, needsPhotoReview: false, reviewed: false }],
    items: [tape("Detected", { photoId: "p" }), tape("Manually added", { photoId: "p" })],
  });
  const photo = session.draft.photos[0];
  assert.equal(photoCountMismatch(photo, session.draft.items), true);
  assert.equal(requiresPhotoReview(photo, session.draft.items), true);
  assert.equal(sessionSummary(session.draft).photoReviews, 1);
  await assert.rejects(session.save(), /count differences/);
  session.confirmPhoto(photo.id, true);
  assert.equal(requiresPhotoReview(photo, session.draft.items), false);
  session.dispose();
});

test("an unavailable live refresh retains prior successful prices, and saves include the matching pricing snapshot", async () => {
  const { session } = fixture({valueEstimate:async () => livePrice(0,{known:false,market:{status:"unavailable"},summary:"Temporarily unavailable"})});
  session.draft.items = [tape("A",{estimate:livePrice(15),pricingStatus:"complete"})]; session.priceAll({refresh:true}); await until(() => session.pricingControllers.size === 0);
  assert.equal(session.draft.items[0].estimate.typical,15); assert.equal(session.draft.items[0].pricingStatus,"error"); assert.match(session.draft.items[0].pricingError,/Temporarily/);
  const payload = tapePayload(session.draft.items[0],session.draft); assert.equal(payload.estimate.typical,15); assert.equal(payload.estimateFor.title,"A"); session.dispose();
});

test("a pricing rate limit stops the remaining queue for an explicit retry", async () => {
  let calls = 0;
  const { session } = fixture({ valueEstimate: async (_subject,{signal}) => {
    calls++;
    if (calls === 1) { const error = new Error("Wait before checking more prices"); error.status = 429; throw error; }
    return new Promise((_resolve,reject) => signal.addEventListener("abort",() => reject(new DOMException("paused","AbortError"))));
  } });
  session.draft.items = Array.from({length:8},(_,index) => tape(`Tape ${index}`)); session.priceAll();
  await until(() => session.pricingControllers.size === 0);
  assert.equal(calls,2); assert.equal(session.pricingPaused,true); assert.equal(session.pricingSummary().errors,1); assert.equal(session.pricingSummary().paused,7); session.dispose();
});
