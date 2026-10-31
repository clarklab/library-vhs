import test from "node:test";
import assert from "node:assert/strict";
import { EBAY_CACHE_MS, cleanupMarketCache, ebayMarketValue, ebayQuery, pickLowest } from "../netlify/lib/ebay.mjs";
import { marketValue } from "../netlify/lib/market.mjs";
import { validMarketEstimate } from "../netlify/lib/market-contract.mjs";
import { storedValue } from "../netlify/lib/value-contract.mjs";

const item = { title: "Alien", year: 1979, format: "VHS", edition: "", artist: "", sealed: null, condition: "unknown", packaging: "", barcode: "" };
const credentials = { clientId: "client", clientSecret: "secret" };
let nextId = 100000000000;
const summary = (title, price, extra = {}) => ({
  itemId: `v1|${nextId}|0`, legacyItemId: String(nextId++), title, price: { value: String(price), currency: "USD" },
  condition: "Good", conditionId: "5000", buyingOptions: ["FIXED_PRICE"], itemWebUrl: `https://www.ebay.com/itm/${nextId - 1}?hash=item`,
  shippingOptions: [{ shippingCost: { value: "4.00", currency: "USD" } }], ...extra,
});
const memoryCache = () => {
  const data = new Map();
  return { data, get: async (key) => structuredClone(data.get(key) ?? null), setJSON: async (key, value) => { data.set(key, structuredClone(value)); }, delete: async (key) => { data.delete(key); },
    async *list() { yield { blobs: [...data.keys()].map((key) => ({ key })) }; } };
};
function ebayApi(pages) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    url = new URL(url); calls.push({ url, options });
    if (url.pathname.endsWith("/oauth2/token")) return Response.json({ access_token: "token", expires_in: 7200 });
    const page = typeof pages === "function" ? pages(url) : pages.shift();
    return page instanceof Response ? page : Response.json({ itemSummaries: page });
  };
  return { calls, fetchImpl, searches: () => calls.filter((call) => call.url.pathname.endsWith("/item_summary/search")) };
}

test("prices come mechanically from the lowest ten comparable listings", async () => {
  const prices = [3, 4, 5, 5, 6, 7, 8, 9, 10, 11, 12, 40];
  const api = ebayApi([[
    ...prices.map((price) => summary("Alien 1979 VHS Sigourney Weaver", price)),
    summary("Aliens VHS 1986", 1), summary("Alien DVD", 1), summary("Alien VHS lot of 3 tapes", 1), summary("Alien VHS tape only no case", 1),
    summary("Alien VHS PAL", 1), summary("Alien VHS factory sealed", 1), summary("Alien VHS", 1, { conditionId: "1000", condition: "New" }),
    summary("Alien VHS", 1, { conditionId: "7000", condition: "For parts or not working" }), summary("Alien VHS auction", 1, { buyingOptions: ["AUCTION"] }),
    summary("Alien VHS", 1, { price: { value: "1", currency: "GBP" } }),
  ]]);
  const result = await ebayMarketValue(item, { fetchImpl: api.fetchImpl, credentials, cache: null });
  assert.equal(result.market.provider, "ebay_browse"); assert.equal(result.market.basis, "asking");
  assert.equal(result.market.sampleCount, 10); assert.equal(result.low, 3); assert.equal(result.high, 11); assert.equal(result.typical, 6.5);
  assert.ok(result.market.warnings.includes("Uses the 10 lowest-priced of 12 matching active eBay listings."));
  assert.match(result.summary, /eBay/); assert.equal(result.market.listings[0].url.startsWith("https://www.ebay.com/itm/"), true);
  assert.equal(validMarketEstimate(result), true); assert.equal(storedValue(result).market.provider, "ebay_browse");
  const [search] = api.searches();
  assert.equal(search.url.searchParams.get("q"), "Alien vhs"); assert.equal(search.url.searchParams.get("category_ids"), "309");
  assert.match(search.url.searchParams.get("filter"), /buyingOptions:\{FIXED_PRICE\}/);
  assert.equal(search.options.headers.authorization, "Bearer token"); assert.equal(search.options.headers["x-ebay-c-marketplace-id"], "EBAY_US");
});

test("a barcode searches by GTIN first and falls back to keywords", async () => {
  const api = ebayApi([[summary("Alien DVD", 5)], [summary("Alien VHS", 7)]]);
  const result = await ebayMarketValue({ ...item, barcode: "0 86162-11134 3" }, { fetchImpl: api.fetchImpl, credentials, cache: null });
  const [byBarcode, byWords] = api.searches();
  assert.equal(byBarcode.url.searchParams.get("gtin"), "086162111343"); assert.equal(byBarcode.url.searchParams.has("q"), false);
  assert.equal(byWords.url.searchParams.get("q"), "Alien vhs"); assert.equal(result.typical, 7);
  assert.equal(ebayQuery({ title: "Greatest Hits (Remastered), Vol. 1", artist: "Queen", format: "CD", edition: "" }), "Queen Greatest Hits Remastered Vol. 1 cd");
});

test("sealed requests only match sealed listings", () => {
  const listings = [summary("Alien VHS Factory Sealed", 30, { conditionId: "1000", condition: "New" }), summary("Alien VHS", 5)];
  assert.deepEqual(pickLowest({ ...item, sealed: true }, listings).listings.map((listing) => listing.price), [30]);
  assert.deepEqual(pickLowest(item, listings).listings.map((listing) => listing.price), [5]);
});

test("results are cached for six hours and swept when expired", async () => {
  let now = Date.parse("2026-10-30T12:00:00Z");
  const cache = memoryCache(), api = ebayApi(() => [summary("Alien VHS", 5)]);
  const options = { fetchImpl: api.fetchImpl, credentials, cache, now: () => now };
  await ebayMarketValue(item, options); await ebayMarketValue({ ...item, title: " alien " }, options);
  assert.equal(api.searches().length, 1);
  now += EBAY_CACHE_MS + 1;
  assert.deepEqual(await cleanupMarketCache({ store: cache, now: () => now }), { checked: 1, deleted: 1 });
  await ebayMarketValue(item, options); assert.equal(api.searches().length, 2);
});

test("missing credentials, unknown items, failures and cancellation never invent prices", async () => {
  assert.equal(await ebayMarketValue(item, { credentials: null }), null);
  const api = ebayApi([new Response("{}", { status: 429 })]);
  assert.equal((await ebayMarketValue({ ...item, title: "Unknown tape" }, { fetchImpl: api.fetchImpl, credentials, cache: null })).market.status, "needs_identification");
  const limited = await ebayMarketValue(item, { fetchImpl: api.fetchImpl, credentials, cache: null });
  assert.equal(limited.market.status, "unavailable"); assert.equal(limited.typical, null); assert.match(limited.market.warnings.join(" "), /daily lookup limit/);
  const empty = await ebayMarketValue(item, { fetchImpl: ebayApi([[]]).fetchImpl, credentials, cache: null });
  assert.equal(empty.market.status, "no_matches"); assert.equal(empty.known, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => ebayMarketValue(item, { fetchImpl: api.fetchImpl, credentials, cache: null, signal: controller.signal }), { name: "AbortError" });
});

test("an expired token is refreshed once", async () => {
  let rejected = false;
  const api = ebayApi(() => rejected ? [summary("Alien VHS", 5)] : (rejected = true, new Response("{}", { status: 401 })));
  const result = await ebayMarketValue(item, { fetchImpl: api.fetchImpl, credentials: { clientId: "refresh", clientSecret: "secret" }, cache: null });
  assert.equal(result.typical, 5); assert.equal(api.calls.filter((call) => call.url.pathname.endsWith("/oauth2/token")).length, 2);
});

test("web search runs only without eBay or when eBay is unavailable", async () => {
  let webCalls = 0;
  const priced = await ebayMarketValue(item, { fetchImpl: ebayApi([[summary("Alien VHS", 5)]]).fetchImpl, credentials, cache: null });
  const unavailable = await ebayMarketValue(item, { fetchImpl: ebayApi([new Response("{}", { status: 500 })]).fetchImpl, credentials, cache: null });
  const noMatches = { ...unavailable, market: { ...unavailable.market, status: "no_matches" } };
  const webResult = { ...priced, market: { ...priced.market, provider: "web_search" } };
  const web = async () => { webCalls++; return webResult; };
  assert.equal(await marketValue(item, { ebay: async () => priced, web }), priced);
  assert.equal(await marketValue(item, { ebay: async () => noMatches, web }), noMatches); assert.equal(webCalls, 0);
  assert.equal(await marketValue(item, { ebay: async () => null, web }), webResult);
  const fallback = await marketValue(item, { ebay: async () => unavailable, web });
  assert.equal(webCalls, 2); assert.equal(fallback.market.provider, "web_search"); assert.match(fallback.market.warnings.join(" "), /Used web search instead/);
});
