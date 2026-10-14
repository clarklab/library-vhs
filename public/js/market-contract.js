export const MARKET_DOMAINS = ["ebay.com/itm", "mercari.com/us/item", "etsy.com/listing", "discogs.com/sell/item"];
export const MARKET_STATUSES = ["available", "no_matches", "unavailable", "needs_identification"];
const text = (value, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? Math.round(value * 100) / 100 : null;
const normalized = (value) => text(value, 10000).normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Only individual marketplace pages can contribute prices, never search pages. */
export function listingUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let match;
    if (host === "ebay.com" && (match = url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/))) return `https://www.ebay.com/itm/${match[1]}`;
    if (host === "mercari.com" && (match = url.pathname.match(/^\/us\/item\/(m?\d+)\/?$/))) return `https://www.mercari.com/us/item/${match[1]}/`;
    if (host === "etsy.com" && (match = url.pathname.match(/^\/listing\/(\d+)(?:\/[^/]*)?\/?$/))) return `https://www.etsy.com/listing/${match[1]}`;
    if (host === "discogs.com" && (match = url.pathname.match(/^\/sell\/item\/(\d+)\/?$/))) return `https://www.discogs.com/sell/item/${match[1]}`;
  } catch { /* Ignore malformed or untrusted URLs. */ }
  return null;
}

/** A model-selected price must actually occur in the provider's quoted evidence. */
export function usdPrices(evidence) {
  evidence = String(evidence);
  const prices = new Set();
  for (const match of evidence.matchAll(/(?:US\s*\$|USD\s*\$?\s*|\$)\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/gi)) {
    const before = evidence.slice(Math.max(0, match.index - 50), match.index);
    const after = evidence.slice(match.index + match[0].length, match.index + match[0].length + 60);
    if (/\b(?:CA|CAD|AU|AUD|NZ|NZD|HK|HKD|SG|SGD|MXN|C|A)\s*$/i.test(before) || /\+\s*$/.test(before)) continue;
    if (/^\s*(?:CAD|AUD|NZD|HKD|SGD|MXN|shipping|delivery|postage|off\b|discount|savings|per (?:month|payment|installment)|\/\s*mo\b)/i.test(after)) continue;
    if (/(?:shipping|delivery|payments? of|installments? of|save|discount|was)\s*:?\s*$/i.test(before)) continue;
    const value = amount(Number(match[1].replaceAll(",", "")));
    if (value !== null) prices.add(value);
  }
  return prices;
}

export function comparableEvidence(detail, source) {
  const corpus = normalized(`${source.title}\n${source.evidence}`);
  const wanted = normalized(detail.title).split(" ").filter((word) => !["a", "an", "the", "and", "of", "in", "on", "for", "with"].includes(word));
  if (!wanted.length || wanted.some((word) => !` ${corpus} `.includes(` ${word} `))) return false;
  if (detail.format === "CD" && normalized(detail.artist).split(" ").filter(Boolean).some((word) => !` ${corpus} `.includes(` ${word} `))) return false;
  const format = detail.format === "Blu-ray" ? "blu ray" : normalized(detail.format);
  if (!format || !` ${corpus} `.includes(` ${format} `)) return false;
  const heading = normalized(source.title);
  if (detail.format === "VHS" && /\b(?:dvd|blu ray|laserdisc|betamax)\b/.test(heading)) return false;
  if (/\b(?:bundle|lot of|lot \d|set of \d|\d+ tapes|\d+ movies)\b/.test(corpus)) return false;
  const target = normalized(`${detail.edition || ""} ${detail.packaging || ""}`);
  for (const special of ["pal", "ex rental", "screener", "promo", "graded", "wata", "vga", "black diamond"]) {
    if (` ${corpus} `.includes(` ${special} `) && !` ${target} `.includes(` ${special} `)) return false;
  }
  const sealed = /\b(?:sealed|unopened)\b/.test(corpus.replace(/\b(?:not|never|no longer) (?:factory )?(?:sealed|unopened)\b/g, ""));
  if (detail.sealed === true ? !sealed : sealed) return false;
  const edition = normalized(detail.edition).split(" ").filter(Boolean);
  if (edition.some((word) => !` ${corpus} `.includes(` ${word} `))) return false;
  return true;
}

const hasSaleEvidence = (evidence) => /\b(?:sold (?:on|for)\b|this (?:item|listing) (?:has )?sold\b|winning bid\b|sold\s*:)/i.test(evidence) && !/\b(?:sold out|not sold|unsold)\b/i.test(evidence);

export function normalizeMarketListing(raw, index = 0) {
  const url = listingUrl(raw?.url), price = amount(raw?.price), evidence = text(raw?.evidence, 600);
  if (!url || price === null || raw.currency !== "USD" || !["asking", "sold"].includes(raw.kind) || !usdPrices(evidence).has(price)) return null;
  if (raw.kind === "sold" && !hasSaleEvidence(evidence)) return null;
  const soldAt = raw.soldAt && Number.isFinite(Date.parse(raw.soldAt)) && evidence.includes(raw.soldAt) ? raw.soldAt : null;
  return {
    id: `listing-${index + 1}`, title: text(raw.title), url, price, currency: "USD", kind: raw.kind,
    condition: text(raw.condition, 100) || "unknown", edition: text(raw.edition, 200) || "unknown",
    shipping: null, soldAt, evidence,
  };
}

/** Validate portable saved evidence without accepting invented summary totals. */
export function validMarketEstimate(value) {
  const market = value?.market;
  if (!market || typeof market !== "object" || Array.isArray(market)) return false;
  const fields = ["status", "basis", "fetchedAt", "sampleCount", "askingCount", "soldCount", "listings", "warnings"];
  if (Object.keys(market).some((key) => !fields.includes(key)) || !MARKET_STATUSES.includes(market.status) || !["asking", "sold", "none"].includes(market.basis)) return false;
  if (typeof market.fetchedAt !== "string" || !Number.isFinite(Date.parse(market.fetchedAt))) return false;
  if (!Array.isArray(market.warnings) || market.warnings.length > 6 || market.warnings.some((warning) => typeof warning !== "string" || warning.length > 200)) return false;
  if (!Array.isArray(market.listings) || market.listings.length > 8) return false;
  const listingFields = ["id", "title", "url", "price", "currency", "kind", "condition", "edition", "shipping", "soldAt", "evidence"];
  for (const listing of market.listings) {
    if (!listing || typeof listing !== "object" || Object.keys(listing).some((key) => !listingFields.includes(key))) return false;
    for (const [key, max] of [["id", 30], ["title", 300], ["url", 600], ["condition", 100], ["edition", 200], ["evidence", 600]]) if (typeof listing[key] !== "string" || listing[key].length > max) return false;
    if (listing.shipping !== null || (listing.soldAt !== null && (typeof listing.soldAt !== "string" || !Number.isFinite(Date.parse(listing.soldAt))))) return false;
  }
  const normalized = normalizeMarketValue(value);
  if (normalized.market.listings.length !== market.listings.length) return false;
  if (market.listings.some((listing, index) => JSON.stringify(normalized.market.listings[index]) !== JSON.stringify(Object.fromEntries(listingFields.map((key) => [key, listing[key]]))))) return false;
  return ["known", "low", "high", "typical", "liveComps", "worthChecking"].every((key) => value[key] === normalized[key])
    && ["status", "basis", "sampleCount", "askingCount", "soldCount"].every((key) => market[key] === normalized.market[key]);
}

export function normalizeMarketValue(result) {
  const input = result?.market || {};
  const seen = new Set();
  const listings = (Array.isArray(input.listings) ? input.listings : []).slice(0, 8).flatMap((raw) => {
    const item = normalizeMarketListing(raw, seen.size);
    if (!item || seen.has(item.url)) return [];
    seen.add(item.url); return [item];
  });
  const sold = listings.filter((item) => item.kind === "sold"), asking = listings.filter((item) => item.kind === "asking");
  const selected = sold.length ? sold : asking;
  const prices = selected.map((item) => item.price).sort((a, b) => a - b);
  const known = prices.length > 0;
  const basis = known ? selected[0].kind : "none";
  const low = known ? prices[0] : null, high = known ? prices.at(-1) : null;
  const typical = known ? Math.round((prices[Math.floor((prices.length - 1) / 2)] + prices[Math.ceil((prices.length - 1) / 2)]) * 50) / 100 : null;
  const status = known ? "available" : MARKET_STATUSES.includes(input.status) && input.status !== "available" ? input.status : "no_matches";
  const fetchedAt = typeof input.fetchedAt === "string" && Number.isFinite(Date.parse(input.fetchedAt)) ? input.fetchedAt : null;
  const warnings = [...new Set([
    "Search indexes can lag; open the source to confirm its current price and availability.",
    ...(basis === "asking" ? ["Asking prices are not completed-sale values."] : []),
    ...(known && prices.length < 3 ? ["Small sample: fewer than three comparable listings."] : []),
    ...(known && basis === "asking" && high > low && high >= low * 4 ? ["Asking prices vary widely. This range does not establish resale value or rarity."] : []),
    ...(Array.isArray(input.warnings) ? input.warnings.filter((item) => typeof item === "string").map((item) => item.slice(0, 200)).slice(0, 4) : []),
  ])].slice(0, 6);
  const summary = known
    ? `${prices.length} comparable ${basis === "sold" ? "reported sold" : "asking-price"} listing${prices.length === 1 ? "" : "s"} found in live web search. The range excludes shipping, taxes and fees; verify edition and condition at the source.`
    : status === "unavailable" ? "Live listing search is unavailable right now. No price has been substituted from AI memory."
      : status === "needs_identification" ? "Confirm the title and format before searching for comparable listings."
        : "No comparable USD listing with a verifiable price was found. No price has been substituted from AI memory.";
  return {
    known, low, high, typical, demand: "steady", factors: warnings.slice(0, 4), summary,
    source: "live_web_search", currency: "USD", liveComps: known, worthChecking: known && typical >= 20,
    market: { status, basis, fetchedAt, sampleCount: prices.length, askingCount: asking.length, soldCount: sold.length, listings, warnings },
  };
}
