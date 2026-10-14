import test from "node:test";
import assert from "node:assert/strict";
import { liveMarketValue, searchEvidence } from "../netlify/lib/market.mjs";
import { listingUrl, usdPrices, comparableEvidence, normalizeMarketValue, validMarketEstimate } from "../netlify/lib/market-contract.mjs";
import { normalizeValue, storedValue } from "../netlify/lib/value-contract.mjs";
import { sanitizeTape } from "../netlify/lib/tape-batch.mjs";
import { updateTapeRecord } from "../netlify/lib/tape-update.mjs";
import { sanitizeScoutInput } from "../netlify/lib/scout-store.mjs";
import { createValueHandler } from "../netlify/functions/value.mjs";
import { scoutPurchasePayload } from "../public/js/scout-utils.js";
import { validateBackup, collectionTable, tableToBackup, encodeCsv, parseDelimited } from "../public/js/backup-formats.js";
import { BACKUP_FORMAT, digest, restoreRecords } from "../netlify/lib/backup-store.mjs";

const url = "https://www.ebay.com/itm/123456789012";
const date = "2026-10-14T12:00:00.000Z";
const item = { title: "Alien", year: 1979, format: "VHS", edition: "", artist: "", sealed: false, condition: "", packaging: "", barcode: "" };
const evidence = "Alien (1979) VHS. Pre-Owned. US $12.50 Buy It Now. Shipping $4.00.";
const listing = (extra = {}) => ({ title: "Alien 1979 VHS", url, price: 12.5, currency: "USD", kind: "asking", condition: "Pre-Owned", edition: "unknown", shipping: null, soldAt: null, evidence, ...extra });
const estimate = (listings = [listing()]) => ({ ...normalizeMarketValue({ source: "live_web_search", market: { status: "available", fetchedAt: date, listings } }), estimatedAt: date });
const response = () => ({ stop_reason: "end_turn", content: [
  { type: "server_tool_use", name: "web_search", id: "search-1" },
  { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ type: "web_search_result", url, title: "Alien 1979 VHS", encrypted_content: "opaque" }] },
  { type: "text", text: "Untrusted model prose says $999999", citations: [{ type: "web_search_result_location", url, cited_text: evidence }] },
] });
const extraction = (extra = {}) => ({ listings: [{ sourceId: "source-1", comparable: true, price: 12.5, currency: "USD", kind: "asking", condition: "Pre-Owned", edition: "unknown", soldAt: null, ...extra }] });

test("evidence must come from a cited individual page returned by the actual search tool", () => {
  const actual = response();
  actual.content[2].citations.push({ type: "web_search_result_location", url: "https://www.ebay.com/itm/999999999999", cited_text: "US $999999" });
  assert.deepEqual(searchEvidence(actual).sources.map((source) => source.url), [url]);
  assert.equal(searchEvidence(actual).sources[0].evidence, evidence);
  actual.content.shift(); assert.equal(searchEvidence(actual).sources.length, 0);
  for (const unsafe of ["https://www.ebay.com/sch/i.html?_nkw=Alien", "https://ebay.com.evil.test/itm/123456789012", "http://www.ebay.com/itm/123456789012", "https://user@ebay.com/itm/123456789012", "https://127.0.0.1/itm/123456789012"]) assert.equal(listingUrl(unsafe), null);
});

test("quoted item amounts exclude shipping, installments, discounts and non-USD prices", () => {
  assert.deepEqual([...usdPrices("US $12.50. Shipping $4.00. Payments of $3.00. Save $2.00. Was $19.00. CA $25.00. AU $30.00.")], [12.5]);
  assert.equal(estimate([listing({ price: 999 })]).known, false);
  assert.deepEqual([...usdPrices("Alien VHS. Price CAD $25.00. US $25.00 shipping. Item price US $3.00. $15.00 AUD. $5.00 per month. $2.00 off.")], [3]);
});

test("comparisons reject another format, sequel, bundle, region and premium edition", () => {
  assert.equal(comparableEvidence(item, listing()), true);
  for (const wrong of ["Aliens 1986 VHS", "Alien DVD", "Alien VHS bundle", "Alien VHS PAL", "Alien VHS sealed", "Alien VHS WATA graded", "Alien VHS ex-rental"]) {
    assert.equal(comparableEvidence(item, { title: wrong, evidence: `${wrong} US $12.50` }), false, wrong);
  }
  assert.equal(comparableEvidence({ ...item, sealed: true }, { title: "Alien VHS Sealed", evidence: "Alien VHS Sealed US $12.50" }), true);
  assert.equal(comparableEvidence({ ...item, edition: "Special edition" }, listing()), false);
  assert.equal(comparableEvidence(item, { title: "Alien VHS", evidence: "Alien VHS used, not sealed. US $12.50" }), true);
  assert.equal(comparableEvidence({ title: "Greatest Hits", format: "CD", artist: "Fleetwood Mac" }, { title: "Queen Greatest Hits CD", evidence: "Queen Greatest Hits CD used US $20.00" }), false);
});

test("asking and explicit sold evidence produce separate sample counts and ranges", () => {
  const sold = [10, 20, 30].map((price, index) => listing({ url: `https://www.ebay.com/itm/12345678901${index}`, kind: "sold", price, evidence: `Alien VHS sold for US $${price}.` }));
  const result = estimate([...sold, listing({ url: "https://www.ebay.com/itm/999999999999", price: 500, evidence: "Alien VHS asking US $500" })]);
  assert.equal(result.market.basis, "sold"); assert.equal(result.typical, 20); assert.equal(result.high, 30);
  assert.equal(result.market.sampleCount, 3); assert.equal(result.market.askingCount, 1);
  assert.equal(estimate([listing({ kind: "sold", evidence: "Alien VHS sold out. US $12.50" })]).known, false);
  assert.equal(estimate([listing({ kind: "sold", evidence: "Alien VHS. Sold: US $12.50." })]).market.basis, "sold");
  const singleSold = estimate([sold[0], listing({ url: "https://www.ebay.com/itm/999999999999", price: 500, evidence: "Alien VHS US $500" })]);
  assert.equal(singleSold.market.basis, "sold"); assert.equal(singleSold.typical, 10); assert.equal(singleSold.market.sampleCount, 1);
  const wide = estimate([listing(), listing({ url: "https://www.ebay.com/itm/999999999999", price: 500, evidence: "Alien VHS US $500" })]);
  assert.ok(wide.market.warnings.some((warning) => /vary widely/.test(warning)));
});

test("live pipeline calculates only prices grounded in tool citations and bounds the search", async () => {
  let request, options;
  const client = { messages: { create: async (body, opts) => { request = body; options = opts; return response(); } } };
  const result = await liveMarketValue(item, { client, runStructured: async () => extraction() });
  assert.equal(result.source, "live_web_search"); assert.equal(result.typical, 12.5); assert.equal(result.market.listings[0].url, url);
  assert.equal(request.tools[0].max_uses, 2); assert.equal(options.maxRetries, 0); assert.ok(options.timeout <= 30000);
  for (const bad of [{ price: 150 }, { sourceId: "invented" }, { comparable: false }]) {
    const rejected = await liveMarketValue(item, { client, runStructured: async () => extraction(bad) });
    assert.equal(rejected.market.status, "no_matches"); assert.equal(rejected.typical, null);
  }
});

test("disabled tools, no evidence and cancellation do not fabricate substitute prices", async () => {
  let extracts = 0;
  const options = { client: { messages: { create: async () => { throw Object.assign(new Error("disabled"), { status: 400 }); } } }, runStructured: async () => { extracts++; return extraction(); } };
  const unavailable = await liveMarketValue(item, options);
  assert.equal(unavailable.market.status, "unavailable"); assert.equal(unavailable.typical, null); assert.equal(extracts, 0);
  assert.equal((await liveMarketValue({ ...item, title: "Unknown" }, options)).market.status, "needs_identification");
  options.client.messages.create = async () => ({ ...response(), content: response().content.slice(0, 2) });
  assert.equal((await liveMarketValue(item, options)).market.status, "no_matches");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => liveMarketValue(item, { ...options, signal: controller.signal }), { name: "AbortError" });
});

test("HTTP endpoint defaults to live search and model-only estimates require explicit mode", async () => {
  let live = 0, ai = 0;
  const handler = createValueHandler({ authenticate: async () => ({ userId: "owner" }), runMarket: async () => { live++; return estimate(); }, runStructured: async () => { ai++; return { known: true, low: 1, high: 3, typical: 2 }; } });
  const req = (extra = {}) => new Request("https://example.test/api/value", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...item, ...extra }) });
  const result = await handler(req()); assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal((await result.json()).source, "live_web_search");
  assert.equal((await (await handler(req({ mode: "ai" }))).json()).source, "ai_estimate"); assert.equal(live, 1); assert.equal(ai, 1);
});

test("saved evidence follows the physical item and is discarded for mismatched identity", () => {
  const price = estimate(); assert.equal(validMarketEstimate(price), true);
  assert.equal(validMarketEstimate({ ...price, typical: 999 }), false); assert.equal(storedValue({ ...price, typical: 999 }), null);
  const payload = { ...item, clientId: "copy-1", estimate: price, estimateFor: item };
  assert.equal(sanitizeTape(payload).estimate.typical, 12.5);
  assert.equal(sanitizeTape({ ...payload, condition: "poor" }).estimate, null);
  const scout = sanitizeScoutInput({ clientId: "list-1", items: [{ ...payload, marker: { x: 0.2, y: 0.8 }, markerIssue: null }] }).items[0];
  assert.equal(scout.estimate.typical, 12.5); assert.deepEqual(scout.marker, { x: 0.2, y: 0.8 });
  const purchase = scoutPurchasePayload(scout); assert.equal(Object.hasOwn(purchase, "marker"), false); assert.equal(sanitizeTape(purchase).estimate.typical, 12.5);
});

test("concurrent tape edits reject stale prices, preserve newer notes and never resurrect deletion", async () => {
  let data = { ...item, id: "one", createdAt: date, notes: "original" }, version = 1, race;
  const store = {
    async getWithMetadata() { return data ? { data: structuredClone(data), etag: String(version) } : null; },
    async setJSON(_key, next, options) {
      if (race) { const action = race; race = null; action(); version++; }
      if (options.onlyIfMatch !== String(version)) return { modified: true }; // SDK false-success case.
      data = structuredClone(next); version++; return { modified: true };
    },
  };
  const args = { store, key: "owner/one", input: { estimate: estimate(), estimateFor: item } };
  race = () => { data.title = "Jaws"; };
  await assert.rejects(() => updateTapeRecord(args), { status: 409 }); assert.equal(data.title, "Jaws"); assert.equal(data.estimate, undefined);
  data.title = "Alien"; race = () => { data.notes = "new notes"; };
  assert.equal((await updateTapeRecord(args)).notes, "new notes"); assert.equal(data.estimate.typical, 12.5);
  const changed = { ...item, edition: "New edition" };
  await updateTapeRecord({ ...args, input: { edition: changed.edition, estimate: estimate(), estimateFor: changed } });
  assert.equal(data.estimate.typical, 12.5, "an explicit edit and its matching evaluated snapshot save together");
  await updateTapeRecord({ ...args, input: { condition: "poor" } }); assert.equal(data.estimate, null);
  race = () => { data = null; };
  await assert.rejects(() => updateTapeRecord({ ...args, input: { notes: "must not resurrect" } }), { status: 404 }); assert.equal(data, null);
});

test("JSON, CSV and spreadsheet rows preserve artist and full price evidence through restore", async () => {
  const tape = { id: "legacy-1", ...item, artist: "Credit", edition: "Standard", condition: "good", packaging: "slipcase", barcode: "001234", status: "keep", estimate: estimate(), createdAt: date, updatedAt: date };
  const scoutId = "list-1";
  const scout = { id: `s_${digest(scoutId)}`, clientId: scoutId, name: "Shop", items: [{ ...item, clientId: "copy-1", estimate: estimate(), marker: { x: 0.3, y: 0.4 }, markerIssue: null }], photos: [], createdAt: date, updatedAt: date };
  const backup = { format: BACKUP_FORMAT, version: 1, source: { accountId: "source" }, exportedAt: date, tapes: [tape], scouts: [scout], covers: [] };
  assert.deepEqual((await validateBackup(backup)).issues, []);
  for (const csv of [false, true]) {
    const rows = collectionTable([tape], { accountId: "source" });
    const result = await tableToBackup(csv ? parseDelimited(encodeCsv(rows)) : rows, { csv });
    assert.deepEqual(result.issues, []); assert.deepEqual(result.backup.tapes[0], tape);
  }
  const records = new Map();
  const store = { get: async (key) => records.get(key) ?? null, setJSON: async (key, value, options) => { if (options.onlyIfNew && records.has(key)) return { modified: false }; records.set(key, value); return { modified: true }; } };
  const restored = await restoreRecords({ stores: { tapes: store }, userId: "target", input: { format: BACKUP_FORMAT, version: 1, source: backup.source, exportedAt: date, kind: "tapes", records: [tape] } });
  assert.equal(restored.created, 1); assert.deepEqual([...records.values()][0].estimate, tape.estimate);
  const tampered = structuredClone(backup); tampered.tapes[0].estimate.market.listings[0].price = 999;
  assert.ok((await validateBackup(tampered)).issues.some((issue) => /price estimate/.test(issue.message)));
});
