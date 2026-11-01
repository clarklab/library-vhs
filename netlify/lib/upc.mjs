import { getStore } from "@netlify/blobs";
import { structured } from "./ai.mjs";
import { ebayGtinTitles } from "./ebay.mjs";

// Barcode → title. Product titles come from eBay listings (when configured)
// and UPCitemdb's free trial lookup (100 requests a day per server IP). A small
// model call only tidies those titles; it never names a tape on its own.
export const UPC_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
export const UPC_MISS_CACHE_MS = 24 * 60 * 60 * 1000;
export const UPC_FORMATS = ["VHS", "DVD", "Blu-ray", "CD", "Other"];

const checkDigitOk = (digits) => {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
};

/** UPC-E (8 digits, number system 0 or 1) to its 12-digit UPC-A form. */
export function expandUpcE(code) {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const s = code[0], d = code.slice(1, 7), check = code[7], last = d[5];
  const body = "012".includes(last) ? `${d[0]}${d[1]}${last}0000${d.slice(2, 5)}`
    : last === "3" ? `${d.slice(0, 3)}00000${d.slice(3, 5)}`
      : last === "4" ? `${d.slice(0, 4)}00000${d[4]}`
        : `${d.slice(0, 5)}0000${last}`;
  return `${s}${body}${check}`;
}

/**
 * Canonical GTIN for a scanned or typed code: 12-digit UPC-A where possible,
 * otherwise EAN-13 or EAN-8. Returns null when the check digit fails.
 */
export function normalizeGtin(raw, format = "") {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 8) {
    const expanded = expandUpcE(digits);
    if (format === "upc_e") return expanded && checkDigitOk(expanded) ? expanded : null;
    if (checkDigitOk(digits)) return digits;
    return expanded && checkDigitOk(expanded) ? expanded : null;
  }
  if (![12, 13, 14].includes(digits.length) || !checkDigitOk(digits)) return null;
  if (digits.length === 14) return digits.startsWith("00") ? digits.slice(2) : digits.startsWith("0") ? digits.slice(1) : digits;
  return digits.length === 13 && digits.startsWith("0") ? digits.slice(1) : digits;
}

const NOISE = /\b(vhs|video ?cassette|videotape|cassette|tape|dvd|blu-?ray|cd|sealed|factory|new|used|rare|vintage|htf|oop|ntsc|clamshell|slipcover|slip ?case|tested|works|great|good|condition|movie|film|lot)\b/gi;

/** Mechanical fallback: the first listing title without format words, years or notes. */
export function titleFromListing(text) {
  const base = String(text || "").replace(/[([{][^)\]}]*[)\]}]/g, " ").split(/\s[-|–—•]\s|,|\s\/\s/)[0];
  return base.replace(NOISE, " ").replace(/\b(19|20)\d{2}\b/g, " ").replace(/[^\p{L}\p{N}'&:!?. -]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function upcitemdbTitles(gtin, { signal, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, { signal: requestSignal, headers: { accept: "application/json" } });
    if (!response.ok) return [];
    const body = await response.json();
    return (Array.isArray(body?.items) ? body.items : []).map((item) => typeof item?.title === "string" ? item.title.trim().slice(0, 200) : "").filter(Boolean);
  } catch {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    return [];
  }
}

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    known: { type: "boolean", description: "false when the titles disagree about which release this is, or none names a film, show or album." },
    title: { type: "string", description: "The work's title only, with normal capitalization." },
    year: { type: ["integer", "null"], description: "Original release year, only when a listing states it; otherwise null." },
    format: { type: "string", enum: UPC_FORMATS },
    edition: { type: "string", description: "A named edition stated in the listings (for example Widescreen or Black Diamond), or empty." },
  },
  required: ["known", "title", "year", "format", "edition"],
  additionalProperties: false,
};

const IDENTIFY_SYSTEM = `You tidy product listing titles that all share one barcode into a catalog entry for a home-video collector.
Use only what the listings say. Return the title of the film, show or album without format words, studio names, cast, condition notes or years.
If the listings disagree about which release this is, or none names a work, set known=false and leave title empty. Never guess from your own knowledge.`;

export const upcCacheStore = () => getStore({ name: "upc-cache", consistency: "strong" });

/** Identify one barcode. Throws AbortError if the request was cancelled. */
export async function lookupUpc(gtin, { signal, cache, now = Date.now, ebay = ebayGtinTitles, upcitemdb = upcitemdbTitles, runStructured = structured } = {}) {
  if (cache === undefined) { try { cache = upcCacheStore(); } catch { cache = null; } }
  const cached = cache ? await cache.get(gtin, { type: "json" }).catch(() => null) : null;
  if (cached?.expiresAt > now() && cached.result) return cached.result;

  const [fromEbay, fromUpcitemdb] = await Promise.all([ebay(gtin, { signal }), upcitemdb(gtin, { signal })]);
  const titles = [...new Set([...(fromUpcitemdb || []), ...(fromEbay || [])])].slice(0, 15);
  const sources = [fromEbay?.length ? "ebay" : "", fromUpcitemdb?.length ? "upcitemdb" : ""].filter(Boolean);
  const miss = { status: "not_found", barcode: gtin, sources };
  let result = miss;

  if (titles.length) {
    let identified = null;
    try {
      const reply = await runStructured({
        system: IDENTIFY_SYSTEM, schema: IDENTIFY_SCHEMA, maxTokens: 1200, effort: "low", timeoutMs: 20000, signal,
        content: [{ type: "text", text: `Barcode ${gtin}. Listing titles:\n${titles.map((title, i) => `${i + 1}. ${title}`).join("\n")}` }],
      });
      identified = reply.known && reply.title.trim() ? { title: reply.title.trim().slice(0, 300), year: Number.isInteger(reply.year) && reply.year > 1880 && reply.year < 2100 ? reply.year : null, format: UPC_FORMATS.includes(reply.format) ? reply.format : "Other", edition: reply.edition.trim().slice(0, 200), identifiedBy: "listings" } : null;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const title = titleFromListing(titles[0]);
      const format = /\bdvd\b/i.test(titles[0]) ? "DVD" : /\bblu-?ray\b/i.test(titles[0]) ? "Blu-ray" : /\bvhs\b/i.test(titles[0]) ? "VHS" : "Other";
      identified = title ? { title, year: null, format, edition: "", identifiedBy: "first_listing" } : null;
    }
    if (identified) result = { status: "found", barcode: gtin, ...identified, sources };
  }
  // Misses and mechanical fallbacks are retried sooner than tidied results.
  const ttl = result.identifiedBy === "listings" ? UPC_CACHE_MS : UPC_MISS_CACHE_MS;
  if (cache) await cache.setJSON(gtin, { expiresAt: now() + ttl, result }).catch(() => {});
  return result;
}
