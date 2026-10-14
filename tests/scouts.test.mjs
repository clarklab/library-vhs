import test from "node:test";
import assert from "node:assert/strict";
import { saveScout, patchScout, sanitizeScoutInput, scoutSummary } from "../netlify/lib/scout-store.mjs";
import { normalizeValue } from "../netlify/lib/value-contract.mjs";
import { scoutPurchasePayload, soldListingUrl } from "../public/js/scout-utils.js";

function storeMock({ phantom = false } = {}) {
  const records = new Map();
  let revision = 0;
  return {
    records,
    async getWithMetadata(key) { return structuredClone(records.get(key) || null); },
    async get(key) { return structuredClone(records.get(key)?.data || null); },
    async setJSON(key, data, options = {}) {
      const current = records.get(key);
      if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
      if (phantom) return { modified: true, etag: "" };
      const etag = String(++revision);
      records.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
  };
}
const item = (clientId, title = "Alien") => ({ clientId, title, format: "VHS", photoId: "photo-1", sourceIndex: 1 });
const input = (items = [item("one")]) => ({ clientId: "stable-list", name: "Thrift shop", items, photos: [{ id: "photo-1", name: "Shelf", image: "data:private-image" }] });
const estimateFor = { title: "Alien", year: null, format: "VHS", edition: "", artist: "" };
const estimate = { known: true, low: 12, high: 40, typical: 25, demand: "steady", factors: [], summary: "AI estimate only." };

test("scout creation is idempotent and excludes binary photos and forged purchase/pricing data", async () => {
  const store = storeMock();
  const args = { store, userId: "owner", input: input([{ ...item("one"), purchasedTapeId: "forged", estimate }]) };
  const first = await saveScout(args);
  const second = await saveScout(args);
  assert.deepEqual(second, first);
  assert.equal(store.records.size, 1);
  assert.deepEqual(first.photos, [{ id: "photo-1", name: "Shelf" }]);
  assert.equal(first.items[0].purchasedTapeId, null);
  assert.equal(first.items[0].estimate, null);
});

test("incremental and concurrent scout saves merge new physical items without replacing edits", async () => {
  const store = storeMock();
  const first = await saveScout({ store, userId: "owner", input: input() });
  await patchScout({ store, tapeStore: storeMock(), userId: "owner", id: first.id, patch: { name: "Renamed", items: [{ clientId: "one", estimate, estimateFor }] } });
  await Promise.all([
    saveScout({ store, userId: "owner", input: input([item("one", "stale title"), item("two")]) }),
    saveScout({ store, userId: "owner", input: input([item("three")]) }),
  ]);
  const saved = (await store.get(`owner/${first.id}`));
  assert.equal(saved.name, "Renamed");
  assert.equal(saved.items.length, 3);
  assert.equal(saved.items.find((i) => i.clientId === "one").title, "Alien");
  assert.equal(saved.items.find((i) => i.clientId === "one").estimate.typical, 25);
});

test("scout list IDs are account scoped", async () => {
  const store = storeMock();
  const a = await saveScout({ store, userId: "user-a", input: input() });
  const b = await saveScout({ store, userId: "user-b", input: { ...input(), name: "Private B" } });
  assert.equal(a.id, b.id);
  assert.equal(store.records.size, 2);
  assert.notEqual(a.name, b.name);
  await assert.rejects(() => patchScout({ store, tapeStore: storeMock(), userId: "user-c", id: a.id, patch: { name: "Intruder" } }), { status: 404 });
});

test("conditional SDK false success cannot confirm a scout list that was never written", async () => {
  const store = storeMock({ phantom: true });
  await assert.rejects(() => saveScout({ store, userId: "owner", input: input() }), { status: 503 });
  assert.equal(store.records.size, 0);
});

test("purchased references must match an owned record and original physical item clientId", async () => {
  const store = storeMock();
  const tapes = storeMock();
  const first = await saveScout({ store, userId: "owner", input: input() });
  const patch = { items: [{ clientId: "one", purchasedTapeId: "tape-1" }] };
  await tapes.setJSON("another-owner/tape-1", { id: "tape-1", clientId: "one" });
  await assert.rejects(() => patchScout({ store, tapeStore: tapes, userId: "owner", id: first.id, patch }), { status: 400 });
  await tapes.setJSON("owner/tape-1", { id: "tape-1", clientId: "wrong-copy" });
  await assert.rejects(() => patchScout({ store, tapeStore: tapes, userId: "owner", id: first.id, patch }), { status: 400 });
  await tapes.setJSON("owner/tape-1", { id: "tape-1", clientId: "one" });
  const bought = await patchScout({ store, tapeStore: tapes, userId: "owner", id: first.id, patch });
  assert.equal(bought.items[0].purchasedTapeId, "tape-1");
  assert.equal(scoutSummary(bought).purchasedCount, 1);
});

test("scout validation rejects invalid identities, duplicate physical IDs and empty titles", () => {
  for (const invalid of [null, {}, { ...input(), clientId: "../path" }, input([null]), input([item("one"), item("one")]), input([item("one", " ")])]) {
    assert.throws(() => sanitizeScoutInput(invalid));
  }
});

test("unknown and contradictory valuations cannot leak numeric estimates or worth-checking flags", () => {
  for (const value of [{ ...estimate, known: false }, { ...estimate, typical: null }, { ...estimate, low: 100 }, { ...estimate, high: -1 }, { ...estimate, typical: Infinity }]) {
    const safe = normalizeValue(value);
    assert.equal(safe.known, false);
    assert.equal(safe.low, null);
    assert.equal(safe.high, null);
    assert.equal(safe.typical, null);
    assert.equal(safe.worthChecking, false);
  }
  const known = normalizeValue(estimate);
  assert.equal(known.worthChecking, true);
  assert.equal(known.source, "ai_estimate");
  assert.equal(known.liveComps, false);
});

test("buying a scouted copy preserves stable identity, explicit format and separate ownership", () => {
  const payload = scoutPurchasePayload({ ...item("one"), format: "DVD", estimate, purchasedTapeId: null });
  assert.equal(payload.clientId, "one");
  assert.equal(payload.format, "DVD");
  assert.equal(payload.source, "scout");
  assert.equal(payload.status, "keep");
  assert.ok(!Object.hasOwn(payload, "estimate"));
  assert.ok(!Object.hasOwn(payload, "photoId"));
  const url = new URL(soldListingUrl({ title: "A & B", artist: "Artist", format: "CD", edition: "Special" }));
  assert.equal(url.searchParams.get("_nkw"), "A & B Artist CD Special");
  assert.equal(url.searchParams.get("LH_Sold"), "1");
});

test("scout HTTP reads and writes enforce authentication and account prefixes", async () => {
  const { createScoutsHandler } = await import("../netlify/functions/scouts.mjs");
  const store = storeMock();
  const first = await saveScout({ store, userId: "private-owner", input: input() });
  const unauthenticated = createScoutsHandler({ authenticate: async () => null, getScouts: () => { throw new Error("Must not open store"); } });
  assert.equal((await unauthenticated(new Request("https://example.test/api/scouts"))).status, 401);
  const otherUser = createScoutsHandler({ authenticate: async () => ({ userId: "another-owner" }), getScouts: () => store });
  assert.equal((await otherUser(new Request(`https://example.test/api/scouts/${first.id}`), { params: { id: first.id } })).status, 404);
  const owner = createScoutsHandler({ authenticate: async () => ({ userId: "private-owner" }), getScouts: () => store });
  const response = await owner(new Request(`https://example.test/api/scouts/${first.id}`), { params: { id: first.id } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).list.name, "Thrift shop");
});

test("value requests carry the explicit physical format and cannot price unidentified objects", async () => {
  const { createValueHandler } = await import("../netlify/functions/value.mjs");
  const calls = [];
  const handler = createValueHandler({ authenticate: async () => ({ userId: "owner" }), runStructured: async (call) => { calls.push(call); return estimate; } });
  const request = (body) => new Request("https://example.test/api/value", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "ai", ...body }) });
  const response = await handler(request({ title: "Album", artist: "An Artist", format: "CD" }));
  const result = await response.json();
  assert.equal(result.format, "CD");
  assert.equal(result.known, true);
  assert.match(calls[0].content[0].text, /"format":"CD"/);
  assert.match(calls[0].content[0].text, /"artist":"An Artist"/);
  assert.match(calls[0].content[0].text, /"sealed":null/);
  for (const body of [{ title: "Unknown", format: "VHS" }, { title: "Could be anything", format: "unknown" }]) {
    const unknown = await (await handler(request(body))).json();
    assert.equal(unknown.known, false);
    assert.equal(unknown.typical, null);
    assert.equal(unknown.worthChecking, false);
  }
});

test("correcting a saved scout identity clears stale pricing while preserving ownership and photo references", async () => {
  const store = storeMock();
  const tapes = storeMock();
  const first = await saveScout({ store, userId: "owner", input: input() });
  await tapes.setJSON("owner/tape-1", { id: "tape-1", clientId: "one" });
  await patchScout({ store, tapeStore: tapes, userId: "owner", id: first.id, patch: { items: [{ clientId: "one", purchasedTapeId: "tape-1", estimate, estimateFor }] } });
  const corrected = await patchScout({ store, tapeStore: tapes, userId: "owner", id: first.id, patch: { items: [{ clientId: "one", title: "Jaws", format: "DVD", year: 1975, edition: "Special edition", estimate, estimateFor }] } });
  const updated = corrected.items[0];
  assert.equal(updated.title, "Jaws");
  assert.equal(updated.format, "DVD");
  assert.equal(updated.year, 1975);
  assert.equal(updated.estimate, null, "a price supplied in the same identity-changing request cannot preserve the old estimate");
  assert.equal(updated.clientId, "one");
  assert.equal(updated.purchasedTapeId, "tape-1");
  assert.equal(updated.photoId, "photo-1");
  assert.equal(updated.sourceIndex, 1);
  assert.equal(corrected.createdAt, first.createdAt);
});

test("unchanged scout identification and evidence-only edits preserve valid estimates", async () => {
  const store = storeMock();
  const first = await saveScout({ store, userId: "owner", input: input() });
  const args = { store, tapeStore: storeMock(), userId: "owner", id: first.id };
  const priced = await patchScout({ ...args, patch: { items: [{ clientId: "one", estimate, estimateFor }] } });
  const corrected = await patchScout({ ...args, patch: { items: [{ clientId: "one", title: " Alien ", format: "VHS", year: null, edition: "", artist: "", visual: "Second shelf" }] } });
  assert.deepEqual(corrected.items[0].estimate, priced.items[0].estimate);
  assert.equal(corrected.items[0].visual, "Second shelf");
  for (const invalid of [{ title: " " }, { title: {} }, { format: "unrecognized" }, { year: 1 }, { year: [1975] }, { year: "bad" }]) {
    await assert.rejects(() => patchScout({ ...args, patch: { items: [{ clientId: "one", ...invalid }] } }), { status: 400 });
  }
});


test("an estimate arriving after another tab corrected the identification cannot overwrite the new item", async () => {
  const store = storeMock();
  const first = await saveScout({ store, userId: "owner", input: input() });
  const args = { store, tapeStore: storeMock(), userId: "owner", id: first.id };
  await patchScout({ ...args, patch: { items: [{ clientId: "one", title: "Jaws", year: 1975 }] } });
  await assert.rejects(() => patchScout({ ...args, patch: { items: [{ clientId: "one", estimate, estimateFor }] } }), { status: 409 });
  const saved = await store.get(`owner/${first.id}`);
  assert.equal(saved.items[0].title, "Jaws");
  assert.equal(saved.items[0].estimate, null);
  const priced = await patchScout({ ...args, patch: { items: [{ clientId: "one", estimate, estimateFor: { ...estimateFor, title: "Jaws", year: 1975 } }] } });
  assert.equal(priced.items[0].estimate.typical, 25);
  assert.ok(!Object.hasOwn(priced.items[0], "estimateFor"));
});
