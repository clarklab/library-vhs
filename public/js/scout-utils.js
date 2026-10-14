export function soldListingUrl(item) {
  const query = [item.title, item.artist, item.format, item.edition].filter(Boolean).join(" ");
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
}

export function scoutPurchasePayload(item) {
  // clientId follows the physical item from scan -> scout -> owned collection.
  // Repeating this action after a network interruption acknowledges that record.
  const { estimate, estimateFor, purchasedTapeId, photoId, sourceIndex, visual, confidence, marker, markerIssue, ...tape } = item;
  const snapshot = Object.fromEntries(["title", "year", "format", "edition", "artist", "condition", "sealed", "packaging", "barcode"].map((key) => [key, item[key]]));
  return {
    ...tape, clientId: item.clientId, source: "scout", status: "keep",
    ...(["ai_estimate", "live_web_search"].includes(estimate?.source) ? { estimate, estimateFor: snapshot } : {}),
  };
}
