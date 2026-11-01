import test from "node:test";
import assert from "node:assert/strict";
import { UPC_CACHE_MS, UPC_MISS_CACHE_MS, expandUpcE, lookupUpc, normalizeGtin, titleFromListing, upcitemdbTitles } from "../netlify/lib/upc.mjs";
import { ebayGtinTitles } from "../netlify/lib/ebay.mjs";
import { createUpcHandler } from "../netlify/functions/upc.mjs";
import { createReadConfirmer, formatBarcode } from "../public/js/barcode.js";

const memoryCache = () => {
  const data = new Map();
  return { data, get: async (key) => structuredClone(data.get(key) ?? null), setJSON: async (key, value) => { data.set(key, structuredClone(value)); } };
};

test("barcodes are validated and normalized to UPC-A where possible", () => {
  assert.equal(normalizeGtin("0 86162-11134 1"), "086162111341");
  assert.equal(normalizeGtin("0086162111341"), "086162111341"); // EAN-13 with a leading zero
  assert.equal(normalizeGtin("00086162111341"), "086162111341"); // GTIN-14
  assert.equal(normalizeGtin("086162111344"), null); // bad check digit
  assert.equal(normalizeGtin("12345"), null);
  assert.equal(normalizeGtin("4006381333931"), "4006381333931"); // real EAN-13
  assert.equal(normalizeGtin("96385074"), "96385074"); // EAN-8
  assert.equal(expandUpcE("04252614"), "042100005264");
  assert.equal(normalizeGtin("04252614", "upc_e"), "042100005264");
  assert.equal(normalizeGtin("04252614"), "042100005264"); // not a valid EAN-8, valid UPC-E
});

test("the mechanical fallback strips format words, years and notes", () => {
  assert.equal(titleFromListing("Jurassic Park (VHS, 1993) Steven Spielberg - Clamshell"), "Jurassic Park Steven Spielberg");
  assert.equal(titleFromListing("NEW Factory Sealed The Goonies VHS 1985"), "The Goonies");
  assert.equal(titleFromListing("Alien [VHS]"), "Alien");
});

test("a lookup tidies listing titles and caches the result", async () => {
  let now = Date.parse("2026-11-01T12:00:00Z");
  const cache = memoryCache();
  let calls = 0, prompt = "";
  const options = {
    cache, now: () => now,
    ebay: async () => ["Jurassic Park VHS 1993 Universal Clamshell", "Jurassic Park (VHS, 1993)"],
    upcitemdb: async () => ["Jurassic Park [VHS]"],
    runStructured: async ({ content }) => { calls++; prompt = content[0].text; return { known: true, title: "Jurassic Park", year: 1993, format: "VHS", edition: "" }; },
  };
  const found = await lookupUpc("096898201230", options);
  assert.deepEqual(found, { status: "found", barcode: "096898201230", title: "Jurassic Park", year: 1993, format: "VHS", edition: "", identifiedBy: "listings", sources: ["ebay", "upcitemdb"] });
  assert.match(prompt, /1\. Jurassic Park \[VHS\]/);
  await lookupUpc("096898201230", options);
  assert.equal(calls, 1);
  assert.equal(cache.data.get("096898201230").expiresAt, now + UPC_CACHE_MS);
});

test("unknown barcodes, disagreeing listings and AI failures never invent a title", async () => {
  const none = await lookupUpc("086162111341", { cache: null, ebay: async () => null, upcitemdb: async () => [], runStructured: async () => assert.fail("no model call without listings") });
  assert.deepEqual(none, { status: "not_found", barcode: "086162111341", sources: [] });

  const unsure = await lookupUpc("086162111341", { cache: null, ebay: async () => ["Lot of 5 tapes"], upcitemdb: async () => [], runStructured: async () => ({ known: false, title: "", year: null, format: "Other", edition: "" }) });
  assert.equal(unsure.status, "not_found");

  const cache = memoryCache(), now = 1000;
  const fallback = await lookupUpc("086162111341", { cache, now: () => now, ebay: async () => [], upcitemdb: async () => ["The Goonies (VHS, 1985) - Warner Home Video"], runStructured: async () => { throw new Error("gateway down"); } });
  assert.deepEqual(fallback, { status: "found", barcode: "086162111341", title: "The Goonies", year: null, format: "VHS", edition: "", identifiedBy: "first_listing", sources: ["upcitemdb"] });
  assert.equal(cache.data.get("086162111341").expiresAt, now + UPC_MISS_CACHE_MS);
});

test("title sources read eBay and UPCitemdb safely", async () => {
  assert.equal(await ebayGtinTitles("086162111341", { credentials: null }), null);
  const urls = [];
  const fetchImpl = async (url) => {
    url = new URL(url); urls.push(url);
    if (url.pathname.endsWith("/oauth2/token")) return Response.json({ access_token: "token", expires_in: 7200 });
    return Response.json({ itemSummaries: [{ title: "Alien VHS" }, { title: "Alien VHS" }, { title: " Alien (1979) VHS " }] });
  };
  assert.deepEqual(await ebayGtinTitles("086162111341", { fetchImpl, credentials: { clientId: "upc-test", clientSecret: "s" } }), ["Alien VHS", "Alien (1979) VHS"]);
  assert.equal(urls.at(-1).searchParams.get("gtin"), "086162111341");
  assert.deepEqual(await ebayGtinTitles("086162111341", { fetchImpl: async () => new Response("{}", { status: 500 }), credentials: { clientId: "upc-fail", clientSecret: "s" } }), []);

  assert.deepEqual(await upcitemdbTitles("086162111341", { fetchImpl: async () => Response.json({ code: "OK", items: [{ title: "Alien [VHS]" }, { brand: "no title" }] }) }), ["Alien [VHS]"]);
  assert.deepEqual(await upcitemdbTitles("086162111341", { fetchImpl: async () => new Response("{}", { status: 429 }) }), []);
});

test("the endpoint requires a session and a complete barcode", async () => {
  const post = (body) => new Request("http://localhost/api/upc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let looked = null;
  const handler = createUpcHandler({ authenticate: async () => ({ userId: "u1" }), lookup: async (gtin) => { looked = gtin; return { status: "not_found", barcode: gtin, sources: [] }; } });
  assert.equal((await createUpcHandler({ authenticate: async () => null })(post({ code: "086162111341" }))).status, 401);
  assert.equal((await handler(post({ code: "0861621" }))).status, 400);
  const response = await handler(post({ code: "0 86162 11134 1" }));
  assert.equal(response.status, 200);
  assert.equal(looked, "086162111341");
  assert.equal((await createUpcHandler({ authenticate: async () => ({}), lookup: async () => { throw new Error("boom"); } })(post({ code: "086162111341" }))).status, 502);
});

test("the camera accepts a code only after two matching reads", () => {
  const confirm = createReadConfirmer();
  assert.equal(confirm("086162111341"), false);
  assert.equal(confirm(""), false);
  assert.equal(confirm("086162111341"), false);
  assert.equal(confirm("086162111341"), true);
  assert.equal(formatBarcode("086162111341"), "0 86162 11134 1");
});
