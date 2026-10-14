import { esc, money } from "./util.js";

const isLive = (estimate) => estimate?.source === "live_web_search";
const dateLabel = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
};
const safeLink = (value) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

export function marketLabel(estimate) {
  if (!estimate) return "Not checked";
  if (estimate.known) return `${money(estimate.low)}–${money(estimate.high)}`;
  if (!isLive(estimate)) return "Estimate unavailable";
  return ({ unavailable: "Check unavailable", needs_identification: "Identify this tape", no_matches: "No matching listings" })[estimate.market?.status] || "No price found";
}

export function marketMeta(estimate) {
  if (!estimate) return "Check current listings";
  const date = dateLabel(estimate.market?.fetchedAt || estimate.estimatedAt);
  if (!isLive(estimate)) return ["AI estimate", date].filter(Boolean).join(" · ");
  const market = estimate.market || {};
  const count = Number.isInteger(market.sampleCount) && market.sampleCount >= 0 ? market.sampleCount : market.listings?.length || 0;
  const label = market.basis === "sold" ? `${count} sold ${count === 1 ? "listing" : "listings"}` : market.basis === "asking" ? `${count} asking ${count === 1 ? "price" : "prices"}` : "No matched price evidence";
  return [label, date ? `Checked ${date}` : ""].filter(Boolean).join(" · ");
}

// Plain labels above can be inserted with textContent. This helper returns
// escaped markup; provider text can never introduce markup or unsafe URLs.
export function marketEvidence(estimate) {
  if (!estimate) return "";
  const market = estimate.market || {};
  const listings = Array.isArray(market.listings) ? market.listings.slice(0,12) : [];
  const summary = typeof estimate.summary === "string" ? estimate.summary : "";
  const factors = Array.isArray(estimate.factors) ? estimate.factors : [];
  const warnings = Array.isArray(market.warnings) ? market.warnings : [];
  const context = !isLive(estimate) ? "AI estimate, not current sold-price evidence." : market.basis === "asking" ? "These are asking prices, not completed sales. Compare the exact format, edition and condition." : market.basis === "sold" ? "Matched sold evidence. Prices can differ by edition, condition, shipping and fees." : "A live check did not establish a supported price for this item.";
  return `<details class="market-evidence"><summary>${listings.length ? `View ${listings.length} ${listings.length === 1 ? "source" : "sources"}` : "Price check details"}</summary><p>${esc(context)}</p>${summary ? `<p>${esc(summary)}</p>` : ""}${listings.length ? `<ul class="market-listings">${listings.map((listing) => {
    const url = safeLink(listing.url);
    const title = typeof listing.title === "string" ? listing.title : "Listing source";
    const price = typeof listing.price === "number" && Number.isFinite(listing.price) ? money(listing.price) : "Price unavailable";
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : `<strong>${esc(title)}</strong>`}<span class="market-listing-label">${esc(price)} · ${listing.kind === "sold" ? "Sold evidence" : "Asking price"}${listing.condition ? ` · ${esc(listing.condition)}` : ""}</span>${listing.edition ? `<p>${esc(listing.edition)}</p>` : ""}${listing.evidence ? `<p>${esc(listing.evidence)}</p>` : ""}${listing.soldAt ? `<p>Sold ${esc(dateLabel(listing.soldAt))}</p>` : ""}</li>`;
  }).join("")}</ul>` : ""}${factors.length ? `<ul>${factors.slice(0,6).map((factor) => `<li>${esc(factor)}</li>`).join("")}</ul>` : ""}${warnings.length ? `<ul class="market-warnings">${warnings.slice(0,8).map((warning) => `<li>${esc(typeof warning === "string" ? warning : warning?.message || "Check this listing against the physical copy.")}</li>`).join("")}</ul>` : ""}<p class="caption">${esc(marketMeta(estimate))}</p></details>`;
}
