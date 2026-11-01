import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { MARKET_LISTING_LIMIT, comparableEvidence, listingUrl, normalizeMarketValue } from "./market-contract.mjs";

// eBay Browse API: free with a developer keyset (5,000 calls/day by default).
// Prices are computed mechanically from active fixed-price listings; no model
// call is involved. Without credentials, callers fall back to web search.
const API = "https://api.ebay.com";
const SCOPE = "https://api.ebay.com/oauth/api_scope";
const CATEGORIES = { VHS: "309", DVD: "617", "Blu-ray": "617", CD: "176984" };
const FORMAT_WORDS = { VHS: "vhs", DVD: "dvd", "Blu-ray": "blu-ray", CD: "cd" };
// Listings that are not a complete, ordinary copy of the requested item.
const PARTIAL = ["tape only", "no case", "no sleeve", "no box", "case only", "empty case", "box only", "cover only", "sleeve only", "artwork only", "insert only", "replacement case", "clamshell only", "reproduction", "custom", "bootleg", "fan made", "box set", "trilogy", "poster"];
const PARTS_CONDITION = "7000", NEW_CONDITION = "1000";
// eBay requires displayed data to be no more than six hours older than eBay's.
export const EBAY_CACHE_MS = 6 * 60 * 60 * 1000;

const words = (value) => ` ${String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const cents = (value) => Math.round(value * 100) / 100;
const dollars = (value) => `$${value.toFixed(2)}`;

export function ebayCredentials(env = process.env) {
  const clientId = env.EBAY_CLIENT_ID?.trim(), clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const tokens = new Map();
async function accessToken({ clientId, clientSecret }, fetchImpl, signal, now) {
  const cached = tokens.get(clientId);
  if (cached && cached.expiresAt > now() + 60000) return cached.value;
  const response = await fetchImpl(`${API}/identity/v1/oauth2/token`, {
    method: "POST", signal,
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }),
  });
  if (!response.ok) throw Object.assign(new Error("eBay token request failed"), { status: response.status });
  const body = await response.json();
  if (typeof body.access_token !== "string") throw new Error("eBay returned no access token");
  tokens.set(clientId, { value: body.access_token, expiresAt: now() + (Number(body.expires_in) || 7200) * 1000 });
  return body.access_token;
}

/** One Browse API search; a rejected token is refreshed once. */
async function browseSearch(params, { credentials, fetchImpl, signal, now }) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(credentials, fetchImpl, signal, now);
    const url = new URL(`${API}/buy/browse/v1/item_summary/search`);
    for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
    const response = await fetchImpl(url, { signal, headers: { authorization: `Bearer ${token}`, "x-ebay-c-marketplace-id": "EBAY_US", accept: "application/json" } });
    if (response.status === 401 && attempt === 0) { tokens.delete(credentials.clientId); continue; }
    if (!response.ok) throw Object.assign(new Error("eBay search failed"), { status: response.status });
    const body = await response.json();
    return Array.isArray(body.itemSummaries) ? body.itemSummaries : [];
  }
}

/** Listing titles that share one barcode. Null without credentials; [] on any failure. */
export async function ebayGtinTitles(gtin, { signal, fetchImpl = fetch, credentials = ebayCredentials(), now = Date.now, timeoutMs = 10000 } = {}) {
  if (!credentials) return null;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const summaries = await browseSearch({ gtin, limit: "20" }, { credentials, fetchImpl, signal: requestSignal, now });
    return [...new Set(summaries.map((summary) => typeof summary?.title === "string" ? summary.title.trim().slice(0, 200) : "").filter(Boolean))];
  } catch {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    return [];
  }
}

/** Keyword query for one item. eBay treats parentheses and commas as OR syntax. */
export function ebayQuery(detail) {
  const parts = [detail.format === "CD" ? detail.artist : "", detail.title, detail.edition, FORMAT_WORDS[detail.format]];
  return parts.filter(Boolean).join(" ").replace(/[(),"*]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

const barcodeOf = (detail) => {
  const digits = String(detail.barcode || "").replace(/\D/g, "");
  return [12, 13, 14].includes(digits.length) ? digits : "";
};

/** Convert one eBay item summary into the shared listing shape, or null. */
export function ebayListing(summary) {
  const price = Number(summary?.price?.value);
  if (summary?.price?.currency !== "USD" || !Number.isFinite(price) || price <= 0) return null;
  if (!summary.buyingOptions?.includes?.("FIXED_PRICE")) return null;
  const id = String(summary.legacyItemId || String(summary.itemId || "").split("|")[1] || "");
  const url = listingUrl(summary.itemWebUrl) || (/^\d{9,15}$/.test(id) ? `https://www.ebay.com/itm/${id}` : null);
  const title = typeof summary.title === "string" ? summary.title.trim().slice(0, 200) : "";
  if (!url || !title) return null;
  const condition = typeof summary.condition === "string" && summary.condition.trim() ? summary.condition.trim().slice(0, 100) : "unknown";
  const cost = summary.shippingOptions?.[0]?.shippingCost, shipping = cost?.currency === "USD" && Number.isFinite(Number(cost.value)) ? Number(cost.value) : null;
  const evidence = [title, `Condition: ${condition}`, `US ${dollars(price)} Buy It Now`, shipping === null ? "" : shipping === 0 ? "Free shipping" : `Shipping ${dollars(shipping)}`].filter(Boolean).join(". ") + ".";
  return { title, url, price: cents(price), currency: "USD", kind: "asking", condition, edition: "unknown", soldAt: null, evidence, conditionId: String(summary.conditionId || "") };
}

/** Mechanical comparability: shared title/format rules plus listing-specific exclusions. */
export function ebayComparable(detail, listing) {
  if (!comparableEvidence(detail, listing)) return false;
  if (listing.conditionId === PARTS_CONDITION || /\bfor parts\b/i.test(listing.condition)) return false;
  if (detail.sealed !== true && listing.conditionId === NEW_CONDITION) return false;
  const title = words(listing.title), wanted = words(`${detail.title} ${detail.edition} ${detail.packaging}`);
  return !PARTIAL.some((phrase) => title.includes(` ${phrase} `) && !wanted.includes(` ${phrase} `));
}

/** The cheapest comparable listings describe what a copy realistically costs. */
export function pickLowest(detail, summaries) {
  const seen = new Set();
  const matches = summaries.flatMap((summary) => {
    const listing = ebayListing(summary);
    if (!listing || seen.has(listing.url) || !ebayComparable(detail, listing)) return [];
    seen.add(listing.url);
    return [listing];
  }).sort((a, b) => a.price - b.price);
  return { matches: matches.length, listings: matches.slice(0, MARKET_LISTING_LIMIT).map(({ conditionId, ...listing }) => listing) };
}

function cacheKey(detail) {
  const subject = [detail.title, detail.format, detail.edition, detail.artist, detail.packaging, barcodeOf(detail), detail.sealed === true].map((value) => typeof value === "string" ? value.trim().toLowerCase() : value);
  return createHash("sha256").update(JSON.stringify(["ebay-v1", ...subject])).digest("hex");
}

export const marketCacheStore = () => getStore({ name: "market-cache", consistency: "strong" });

/** Bounded hourly sweep; expired copies of eBay data must not be retained. */
export async function cleanupMarketCache({ store = marketCacheStore(), now = Date.now, limit = 500 } = {}) {
  let checked = 0, deleted = 0;
  for await (const page of store.list({ paginate: true })) {
    for (const { key } of page.blobs) {
      if (checked++ >= limit) return { checked, deleted };
      const entry = await store.get(key, { type: "json" }).catch(() => null);
      if (!entry || !(entry.expiresAt > now())) { await store.delete(key).catch(() => {}); deleted++; }
    }
  }
  return { checked, deleted };
}

/** Returns null when eBay credentials are not configured. */
export async function ebayMarketValue(detail, { signal, fetchImpl = fetch, credentials = ebayCredentials(), cache, now = Date.now, timeoutMs = 15000 } = {}) {
  if (!credentials) return null;
  const fetchedAt = new Date(now()).toISOString();
  const result = (status, listings = [], warnings = []) => ({
    ...normalizeMarketValue({ source: "live_web_search", market: { provider: "ebay_browse", status, listings, fetchedAt, warnings } }),
    estimatedAt: new Date(now()).toISOString(),
  });
  if (!FORMAT_WORDS[detail.format] || /^(unknown|unreadable|unidentified)(\b|$)/i.test(detail.title)) return result("needs_identification");
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");

  if (cache === undefined) { try { cache = marketCacheStore(); } catch { cache = null; } }
  const key = cacheKey(detail);
  const cached = cache ? await cache.get(key, { type: "json" }).catch(() => null) : null;
  if (cached?.expiresAt > now() && cached.result) return cached.result;

  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const search = (params) => browseSearch({ ...params, limit: "100", filter: "buyingOptions:{FIXED_PRICE},priceCurrency:USD,itemLocationCountry:US" }, { credentials, fetchImpl, signal: requestSignal, now });

  try {
    const category_ids = CATEGORIES[detail.format], gtin = barcodeOf(detail);
    let picked = gtin ? pickLowest(detail, await search({ gtin, category_ids })) : { matches: 0, listings: [] };
    if (!picked.listings.length) picked = pickLowest(detail, await search({ q: ebayQuery(detail), category_ids }));
    const { matches, listings } = picked;
    const value = result(listings.length ? "available" : "no_matches", listings, matches > listings.length
      ? [`Uses the ${listings.length} lowest-priced of ${matches} matching active eBay listings.`]
      : matches ? [`Uses all ${matches} matching active eBay listing${matches === 1 ? "" : "s"}.`] : []);
    if (cache) await cache.setJSON(key, { expiresAt: now() + EBAY_CACHE_MS, result: value }).catch(() => {});
    return value;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const reason = error?.status === 429 ? "eBay's daily lookup limit was reached." : error?.name === "TimeoutError" ? "eBay search timed out." : "eBay search could not complete this request.";
    return result("unavailable", [], [reason]);
  }
}
