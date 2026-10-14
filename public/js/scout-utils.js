export function soldListingUrl(item) {
  const query = [item.title, item.artist, item.format, item.edition].filter(Boolean).join(" ");
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
}

export function scoutPurchasePayload(item) {
  // clientId follows the physical item from scan -> scout -> owned collection.
  // Repeating this action after a network interruption acknowledges that record.
  const { estimate, purchasedTapeId, photoId, sourceIndex, visual, confidence, ...tape } = item;
  return { ...tape, clientId: item.clientId, source: "scout", status: "keep" };
}
