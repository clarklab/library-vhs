import { icons } from "./icons.js";
import { openPhotoPreview } from "./photo-preview.js";
import { createPhotoMap, tapePins, countPins, markerPoint } from "./photo-markers.js";
import { marketLabel, marketMeta, marketEvidence } from "./market-view.js";
import { esc } from "./util.js";
import { openSheet, toast } from "./ui.js";
import { state, go, upsertTapes } from "./app.js";
import { openScanSession, MAX_PHOTOS, sessionSummary, duplicateWarnings, requiresReview, isItemSaved, photoCountMismatch } from "./scan-session.js";

let unsubscribe, disposeMap;
let renderEpoch = 0;
const amount = (value) => value.trim() === "" ? null : Math.max(0, Number(value) || 0);
const alive = (root, userId) => root.isConnected && state.view === "scan" && state.user?.id === userId && root.querySelector("[data-scan-workspace]");

export async function renderScan(root) {
  const epoch = ++renderEpoch;
  unsubscribe?.(); disposeMap?.();
  const userId = state.user?.id;
  root.innerHTML = `<div class="screen scan-screen"><div class="scan-loading" role="status"><span class="spinner"></span> Opening your photos…</div></div>`;
  let session;
  try { session = await openScanSession(userId); }
  catch (error) {
    if (epoch === renderEpoch && state.view === "scan" && state.user?.id === userId) {
      root.innerHTML = `<div class="screen section-pad"><h1>Couldn’t open your draft</h1><p>${esc(error.message)}</p><button class="btn" data-reopen>Try again</button></div>`;
      root.querySelector("[data-reopen]").onclick = () => renderScan(root);
    }
    return;
  }
  if (epoch !== renderEpoch || state.view !== "scan" || state.user?.id !== userId) return;
  let activePhotoId = session.draft.photos[0]?.id, selectedId = null;
  let filter = "all", search = "", visibleLimit = 50, compareCount = false, placement = null, pendingMarker = null;
  const itemNodes = new Map(), photoNodes = new Map();
  let lastAnnouncement = "";
  root.innerHTML = `<div class="screen scan-screen scan-simple" data-scan-workspace>
    <header class="scan-header"><div><p class="eyebrow">SEE WHAT WE FOUND.</p><h1>Scan your tapes<span class="accent-dot">.</span></h1><p class="scan-intro">Check the dots. Keep the finds.</p></div><button type="button" class="btn gray" data-new-batch>New batch</button></header>
    <p class="scan-storage-warning" data-storage-warning role="alert" hidden></p>
    <section class="scan-upload-panel" data-dropzone><div data-upload-copy><span class="scan-upload-icon">${icons.camera}</span><h2>Start with your shelf.</h2><p>Use a few clear photos, up to 10 at a time.</p></div><div class="scan-capture-actions"><button class="btn" type="button" data-camera>${icons.camera} Take a photo</button><button class="btn gray" type="button" data-upload>${icons.photo} Choose photos</button></div><input type="file" accept="image/*" capture="environment" hidden data-file-camera /><input type="file" accept="image/*" multiple hidden data-file-library /><p class="scan-upload-tip" data-upload-tip>Closer photos make small spines easier to read. You can also drop photos here.</p></section>
    <section class="scan-batch" data-batch hidden><div class="scan-photo-strip" data-photos aria-label="Your photos"></div><div class="scan-batch-controls"><p data-queue-status role="status"></p><details class="scan-reading-options"><summary>Reading options</summary><label for="scan-mode">Photo detail</label><select id="scan-mode" data-mode><option value="fast">Everyday</option><option value="thorough">Extra care for tricky labels</option></select></details><button class="btn" data-run disabled>Read photos</button></div></section>
    <div class="scan-visual-workspace" data-visual-workspace hidden>
      <section class="scan-photo-panel" aria-label="Check the photo"><div class="scan-map-heading"><div><h2 data-photo-heading>Photo 1</h2><p data-photo-coverage></p></div><button class="btn gray" data-expand aria-label="Enlarge selected photo">${icons.search} Enlarge</button></div><div data-photo-map></div>
        <div class="scan-map-legend"><span><i></i> <span data-marker-legend>A dot links to a title</span></span><button class="scan-text-button" data-compare-count hidden>Compare count</button></div>
        <p class="scan-map-hint" data-map-hint>Dots are suggested positions. Check for a tape without one.</p>
        <div class="scan-coverage-alert" data-coverage-alert hidden><p data-coverage-text></p><label><input type="checkbox" data-photo-confirm /><span>I checked every tape in this photo.</span></label></div>
        <div class="scan-placement-note" data-placement-note hidden><span data-placement-text>Tap the tape to place its dot.</span><button class="scan-text-button" data-cancel-place>Cancel</button></div>
        <div class="scan-map-actions"><button class="btn gray" data-add-dot>${icons.plus} Add a missed tape</button><button class="scan-text-button" data-manual-toggle>Type a title instead</button><button class="scan-text-button" data-retry-photo hidden>Retry photo</button><button class="scan-text-button" data-remove-photo>Remove photo</button></div>
        <form class="scan-manual-form" data-manual-form hidden><label>Missed title<input class="text-field" data-manual-title name="title" placeholder="Title on the tape" maxlength="300" required /></label><label>Source photo<select data-manual-photo aria-label="Source photo"><option value="">No photo</option></select></label><button class="btn" type="submit">Add title</button></form>
        <details class="scan-photo-notes" data-photo-notes hidden><summary>Scan notes</summary><div data-notes></div></details>
      </section>
      <section class="scan-results-panel" aria-labelledby="scan-results-heading"><div class="scan-results-heading"><div><p class="eyebrow">MATCH THE NUMBERS</p><h2 id="scan-results-heading">Your tapes <span data-result-count>0</span></h2></div><button class="btn gray" data-prices>Check live prices</button></div><div class="scan-price-progress" data-price-progress hidden role="status"><span data-price-message></span><button class="scan-text-button" data-pause-prices>Pause</button></div>
        <div class="scan-result-tools"><div class="scan-review-filters" role="group" aria-label="Filter recognized tapes"><button class="active" data-filter="all" aria-pressed="true">All</button><button data-filter="review" aria-pressed="false">Check <span data-count-review>0</span></button><button data-filter="duplicates" aria-pressed="false">Repeats <span data-count-duplicates>0</span></button></div><label class="scan-search">${icons.search}<input type="search" placeholder="Find a title" aria-label="Find a title in this batch" data-search /></label></div>
        <div class="scan-review-empty" data-empty><span class="scan-empty-reels">${icons.tape}</span><h3>Ready when you are.</h3><p>Read your photos to see the titles and their dots.</p></div><p class="scan-review-notice" data-review-notice hidden></p><div class="scan-review-list" data-items></div><button class="btn gray scan-show-more" data-more hidden>Show more titles</button>
      </section>
    </div>
    <section class="scan-finish" data-finish hidden><div class="scan-finish-heading"><div><p class="eyebrow">WHAT WOULD YOU LIKE TO KEEP?</p><h2 data-save-summary></h2><p data-save-detail></p></div><div class="scan-finish-actions"><button class="btn" data-save data-destination="collection">${icons.library} Add to shelf</button><button class="btn gray" data-save-scout data-destination="scout">${icons.search} Just browsing</button></div></div><p class="scan-save-error" data-save-error role="alert" hidden></p><details class="scan-extra-options"><summary>Optional details</summary><button class="btn gray" data-enrich>${icons.sparkles} Add film details</button><p class="hint" data-enrich-message></p><div class="scan-bulk-fields"><label>Paid per tape ($)<input type="number" min="0" step="0.01" inputmode="decimal" data-paid placeholder="0.00" /></label><label>Asking price ($)<input type="number" min="0" step="0.01" inputmode="decimal" data-asking placeholder="0.00" /></label><label>Storage location<input data-location maxlength="160" placeholder="Shelf or box" /></label></div></details><button class="scan-text-button" data-library>Back to collection</button></section>
    <p class="scan-device-note" data-draft-status>Photos and review edits are saved on this device.</p><div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-announcement></div>
  </div>`;
  const $ = (selector) => root.querySelector(selector);
  const activePhoto = () => session.draft.photos.find((photo) => photo.id === activePhotoId);
  const photoItems = (photo) => session.draft.items.filter((item) => item.photoId === photo?.id).map((item) => ({ ...item, displayNumber: session.draft.items.indexOf(item) + 1 }));
  const map = createPhotoMap($("[data-photo-map]"), { onSelect: selectPin, onPlace: placeMarker });
  disposeMap = () => map.destroy();
  const observer = new MutationObserver(() => { if (!alive(root, userId)) { map.destroy(); observer.disconnect(); } });
  observer.observe(document.getElementById("app"), { childList: true, subtree: true });

  function selectPin(pin) {
    if (pin.counter) { toast("A suggested count position. Compare it with the title dots."); return; }
    selectItem(pin.id, true);
  }
  function selectItem(id, scroll = false) {
    const item = session.draft.items.find((entry) => entry.clientId === id);
    if (!item) return;
    if (placement && placement.id !== id) placement = null;
    selectedId = id;
    if (item.photoId && item.photoId !== activePhotoId) { placement = null; activePhotoId = item.photoId; }
    compareCount = false;
    if (scroll) { filter = "all"; search = ""; $("[data-search]").value = ""; visibleLimit = Math.max(visibleLimit, session.draft.items.indexOf(item) + 1); }
    update();
    if (scroll) itemNodes.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function beginPlacement(id = "new") {
    if (session.saving || !activePhoto()?.image) return;
    placement = { id, photoId: activePhotoId }; compareCount = false; update(); map.focusPlacement();
  }
  function placeMarker(marker) {
    if (!placement || session.saving || !alive(root, userId)) return;
    if (placement.photoId !== activePhotoId) { placement = null; update(); return; }
    if (placement.id === "new") {
      pendingMarker = { marker, photoId: activePhotoId }; placement = null;
      $("[data-manual-form]").hidden = false; update();
      $("[data-manual-photo]").value = activePhotoId || ""; $("[data-manual-title]").focus();
    } else {
      const id = placement.id;
      if (session.draft.items.find((item) => item.clientId === id)?.photoId !== placement.photoId) { placement = null; update(); return; }
      placement = null;
      session.updateItem(id, { marker }); selectItem(id); toast("Dot moved. Check that its title matches.");
    }
  }
  function showPhoto() {
    const photo = activePhoto(); if (!photo?.image) return;
    openPhotoPreview({ photo, number: session.draft.photos.indexOf(photo) + 1, titles: photoItems(photo), compareCount,
      onSelect: (id) => selectItem(id, true), onPlace: placement ? placeMarker : null });
  }
  function createItem(item) {
    const node = document.createElement("article"); node.className = "scan-item scan-tape-row"; node.dataset.itemId = item.clientId;
    node.innerHTML = `<div class="scan-tape-main"><label class="scan-tape-check"><input type="checkbox" data-include aria-label="Include this tape" /></label><button class="scan-tape-number" data-source aria-label="Find tape in photo"></button><div class="scan-tape-title"><input data-title maxlength="300" aria-label="Tape title" /><p data-item-caption></p></div><div class="scan-price-cell"><button class="scan-price-button" data-price-one>Check price</button><span data-price-caption></span></div></div><div class="scan-tape-flags"><span data-confidence></span><span data-repeat hidden>Possible repeat</span><button class="scan-text-button" data-edit>Details</button></div><label class="scan-confirm" data-confirm-wrap hidden><input type="checkbox" data-confirm /><span>I checked this title against the photo.</span></label><div class="scan-tape-details" data-item-details hidden><div class="scan-item-fields"><label>Year<input data-year type="number" min="1888" max="2100" aria-label="Release year" /></label><label>Format<select data-format aria-label="Media format"><option value="unknown">Check format</option><option>VHS</option><option>DVD</option><option>CD</option><option>Blu-ray</option><option value="other">Other</option></select></label><label>Edition<input data-edition maxlength="200" placeholder="Optional" aria-label="Tape edition" /></label></div><p class="scan-item-meta" data-meta></p><p class="scan-warning" data-warning hidden></p><button class="scan-text-button" data-place-item>Move its dot</button><div data-price-evidence></div></div>`;
    node.querySelector("[data-include]").onchange = (event) => session.updateItem(item.clientId, { include: event.target.checked });
    node.querySelector("[data-title]").oninput = (event) => session.updateItem(item.clientId, { title: event.target.value, confirmed: false, matched: false });
    node.querySelector("[data-title]").onfocus = () => { if (selectedId !== item.clientId) selectItem(item.clientId); };
    node.querySelector("[data-year]").oninput = (event) => session.updateItem(item.clientId, { year: event.target.value ? Number(event.target.value) : null });
    node.querySelector("[data-format]").onchange = (event) => session.updateItem(item.clientId, { format: event.target.value });
    node.querySelector("[data-edition]").oninput = (event) => session.updateItem(item.clientId, { edition: event.target.value });
    node.querySelector("[data-confirm]").onchange = (event) => session.updateItem(item.clientId, { confirmed: event.target.checked });
    node.querySelector("[data-source]").onclick = () => { selectItem(item.clientId); $("[data-photo-map]").scrollIntoView({ behavior: "smooth", block: "center" }); };
    node.querySelector("[data-edit]").onclick = () => { placement = null; selectedId = selectedId === item.clientId ? null : item.clientId; if (item.photoId && item.photoId !== activePhotoId) activePhotoId = item.photoId; update(); };
    node.querySelector("[data-place-item]").onclick = () => { selectItem(item.clientId); beginPlacement(item.clientId); };
    node.querySelector("[data-price-one]").onclick = () => { session.requestPricing(item.clientId, { refresh: true }); };
    return node;
  }
  function update() {
    if (!alive(root, userId)) return;
    const draft = session.draft, stats = sessionSummary(draft), duplicates = duplicateWarnings(draft.items, state.tapes);
    if (!draft.photos.some((photo) => photo.id === activePhotoId)) { activePhotoId = draft.photos[0]?.id; placement = null; pendingMarker = null; }
    const photo = activePhoto(), running = !draft.paused && stats.pending > 0;
    $("[data-batch]").hidden = !stats.photos; $("[data-visual-workspace]").hidden = !stats.photos && !draft.items.length;
    $("[data-dropzone]").classList.toggle("has-photos", stats.photos > 0);
    $("[data-upload-copy]").hidden = $("[data-upload-tip]").hidden = stats.photos > 0;
    $("[data-storage-warning]").hidden = !session.storageError; $("[data-storage-warning]").textContent = session.storageError;
    $("[data-camera]").disabled = $("[data-upload]").disabled = stats.photos >= MAX_PHOTOS || session.saving;
    $("[data-new-batch]").disabled = session.saving || session.preparing > 0 || (!stats.photos && !draft.items.length);
    $("[data-mode]").value = draft.mode; $("[data-mode]").disabled = session.saving || running;
    $("[data-queue-status]").textContent = stats.pending ? `${stats.completed} of ${stats.photos} photos read${draft.paused ? " · paused" : ""}` : stats.errors ? `${stats.errors} photo${stats.errors === 1 ? "" : "s"} couldn’t be read` : `${stats.completed} photo${stats.completed === 1 ? "" : "s"} read`;
    const run = $("[data-run]"); run.disabled = (!stats.pending && !stats.errors) || session.saving;
    run.textContent = running ? "Pause reading" : stats.pending ? `${stats.completed ? "Resume reading" : `Read ${stats.pending} photo${stats.pending === 1 ? "" : "s"}`}` : stats.errors ? "Retry failed photos" : "All photos read";
    for (const [id, node] of photoNodes) if (!draft.photos.some((entry) => entry.id === id)) { node.remove(); photoNodes.delete(id); }
    draft.photos.forEach((entry, index) => {
      let node = photoNodes.get(entry.id);
      if (!node) { node = document.createElement("button"); node.type = "button"; node.className = "scan-photo-tab"; node.dataset.preview = entry.id; node.innerHTML = '<img alt="" /><span></span><small></small>'; $("[data-photos]").append(node); photoNodes.set(entry.id, node); node.onclick = () => { if (activePhotoId === entry.id) showPhoto(); else { activePhotoId = entry.id; placement = null; compareCount = false; update(); } }; }
      if (entry.image && node.querySelector("img").getAttribute("src") !== entry.image) node.querySelector("img").src = entry.image;
      node.querySelector("span").textContent = `Photo ${index + 1}`;
      const photoNeedsCheck = (entry.needsPhotoReview || photoCountMismatch(entry, draft.items)) && !entry.reviewed;
      node.classList.toggle("needs-check", photoNeedsCheck);
      node.querySelector("small").textContent = entry.status === "complete" ? photoNeedsCheck ? "Check photo" : `${draft.items.filter((item) => item.photoId === entry.id).length} tapes` : entry.status === "processing" ? "Reading…" : entry.status === "error" ? "Retry" : entry.status === "preparing" ? "Preparing…" : "Ready";
      node.classList.toggle("active", entry.id === activePhotoId); node.setAttribute("aria-pressed", String(entry.id === activePhotoId)); node.setAttribute("aria-label", `Photo ${index + 1}: ${node.querySelector("small").textContent}`); node.disabled = !entry.image;
    });
    const items = photoItems(photo), pins = tapePins(items), unplaced = items.length - pins.length;
    $("[data-photo-heading]").textContent = photo ? `Photo ${draft.photos.indexOf(photo) + 1}` : "No source photo";
    const counted = photo?.verification?.countedCount;
    $("[data-photo-coverage]").textContent = photo?.status === "complete" ? `${pins.length} dots · ${items.length} titles${Number.isInteger(counted) ? ` · ${counted} counted` : ""}` : photo?.status === "processing" ? photo.stage === "verifying" ? "Taking a closer look…" : "Finding your tapes…" : "Your titles will be marked here.";
    map.update({ photo, pins: compareCount ? countPins(photo) : pins, selectedId, placing: placement });
    $("[data-marker-legend]").textContent = compareCount ? "Independent count positions" : "A dot links to a title";
    $("[data-compare-count]").hidden = !countPins(photo).length; $("[data-compare-count]").textContent = compareCount ? "Show title dots" : "Compare count";
    $("[data-map-hint]").textContent = compareCount ? "Outlined dots show the separate count. Their numbers are not title matches." : unplaced ? `${unplaced} title${unplaced === 1 ? " has" : "s have"} no dot yet. Open Details to place one.` : "Tap a pink dot to find its title. Enlarge crowded photos to see every number.";
    const countMismatch = photo ? photoCountMismatch(photo, draft.items) : false;
    $("[data-coverage-alert]").hidden = !photo?.needsPhotoReview && !countMismatch;
    $("[data-coverage-text]").textContent = countMismatch ? `Count check: ${counted} counted, ${items.length} listed. Look for missed or repeated tapes.` : "Check the photo once more. Some tape positions or boundaries were unclear.";
    $("[data-photo-confirm]").checked = Boolean(photo?.reviewed); $("[data-photo-confirm]").disabled = session.saving;
    $("[data-placement-note]").hidden = !placement; $("[data-placement-text]").textContent = placement?.id === "new" ? "Tap the missed tape, then give it a title." : "Tap the matching tape to move its dot. You can enlarge the photo.";
    $("[data-add-dot]").disabled = $("[data-expand]").disabled = !photo?.image || session.saving;
    $("[data-remove-photo]").disabled = session.saving || !photo;
    $("[data-retry-photo]").hidden = photo?.status !== "error";
    const notes = [photo?.error, photo?.verificationError, photo?.notes].filter(Boolean);
    $("[data-photo-notes]").hidden = !notes.length; $("[data-notes]").textContent = notes.join(" ");
    $("[data-result-count]").textContent = draft.items.length; $("[data-count-review]").textContent = stats.needsReview; $("[data-count-duplicates]").textContent = duplicates.size;
    root.querySelectorAll("[data-filter]").forEach((button) => { button.classList.toggle("active", button.dataset.filter === filter); button.setAttribute("aria-pressed", String(button.dataset.filter === filter)); });
    const matching = draft.items.filter((item) => (!search || item.title.toLowerCase().includes(search)) && (filter === "review" ? requiresReview(item) : filter === "duplicates" ? duplicates.has(item.clientId) : true));
    const shown = matching.slice(0, visibleLimit), shownIds = new Set(shown.map((item) => item.clientId));
    for (const [id, node] of itemNodes) if (!shownIds.has(id)) { node.remove(); itemNodes.delete(id); }
    shown.forEach((item, index) => {
      let node = itemNodes.get(item.clientId); if (!node) { node = createItem(item); itemNodes.set(item.clientId, node); }
      if ($("[data-items]").children[index] !== node) $("[data-items]").insertBefore(node, $("[data-items]").children[index] || null);
      node.className = `scan-item scan-tape-row${selectedId === item.clientId ? " selected" : ""}${requiresReview(item) ? " needs-review" : ""}${item.include === false ? " excluded" : ""}${isItemSaved(item) ? " saved" : ""}`;
      for (const [selector, value] of [["[data-title]", item.title], ["[data-year]", item.year], ["[data-format]", item.format || "unknown"], ["[data-edition]", item.edition]]) { const input = node.querySelector(selector); if (document.activeElement !== input) input.value = value ?? ""; }
      node.querySelector("[data-include]").checked = item.include !== false;
      node.querySelector("[data-confirm]").checked = Boolean(item.confirmed);
      node.querySelectorAll("input,select").forEach((el) => { el.disabled = Boolean(isItemSaved(item) || session.saving); });
      const number = draft.items.indexOf(item) + 1, photoIndex = draft.photos.findIndex((entry) => entry.id === item.photoId);
      node.querySelector("[data-source]").textContent = number; node.querySelector("[data-source]").disabled = photoIndex < 0;
      node.querySelector("[data-item-caption]").textContent = [item.year, item.format || "Check format", photoIndex >= 0 && draft.photos.length > 1 ? `Photo ${photoIndex + 1}` : ""].filter(Boolean).join(" · ");
      node.querySelector("[data-confidence]").textContent = isItemSaved(item) ? "Saved" : requiresReview(item) ? "Check this tape" : item.confirmed ? "Checked" : "";
      node.querySelector("[data-repeat]").hidden = !duplicates.has(item.clientId);
      node.querySelector("[data-item-details]").hidden = selectedId !== item.clientId;
      node.querySelector("[data-edit]").textContent = selectedId === item.clientId ? "Close details" : "Details";
      node.querySelector("[data-confirm-wrap]").hidden = !item.needsReview || item.include === false || isItemSaved(item);
      node.querySelector("[data-meta]").textContent = item.visual || "";
      const duplicate = duplicates.get(item.clientId); node.querySelector("[data-warning]").hidden = !duplicate;
      node.querySelector("[data-warning]").textContent = duplicate ? "A matching title appears elsewhere. Keep separate physical copies; uncheck the same tape photographed twice." : "";
      node.querySelector("[data-place-item]").textContent = markerPoint(item.marker) ? "Move its dot" : "Place its dot";
      node.querySelector("[data-place-item]").disabled = photoIndex < 0 || session.saving || isItemSaved(item);
      const price = node.querySelector("[data-price-one]");
      price.textContent = item.pricingStatus === "loading" ? "Checking…" : item.pricingStatus === "queued" ? "Queued" : item.pricingStatus === "error" ? "Retry price" : item.estimate ? marketLabel(item.estimate) : "Check price";
      node.querySelector("[data-price-caption]").textContent = item.estimate ? marketMeta(item.estimate).split(" · ")[0] : "";
      price.title = item.pricingError || (item.estimate ? marketMeta(item.estimate) : "Check live listings for this tape");
      price.disabled = session.saving || ["loading", "queued"].includes(item.pricingStatus) || isItemSaved(item) || item.include === false || /^(unknown|unreadable|unidentified)(\b|$)/i.test(item.title) || item.format === "unknown";
      const evidence = node.querySelector("[data-price-evidence]");
      const html = item.estimate ? marketEvidence(item.estimate) : item.pricingError ? `<p class="scan-price-error">${esc(item.pricingError)}</p>` : "";
      if (evidence.innerHTML !== html) evidence.innerHTML = html;
    });
    $("[data-empty]").hidden = draft.items.length > 0; $("[data-review-notice]").hidden = !draft.items.length || matching.length > 0; $("[data-review-notice]").textContent = "No titles match this view.";
    $("[data-more]").hidden = matching.length <= shown.length; $("[data-more]").textContent = `Show more titles (${shown.length} of ${matching.length})`;
    const pricing = session.pricingSummary();
    $("[data-prices]").textContent = pricing.completed > 0 && pricing.completed === pricing.eligible ? "Refresh prices" : pricing.paused ? "Resume price checks" : "Check live prices";
    $("[data-prices]").disabled = !pricing.eligible || session.saving || pricing.active > 0 || pricing.queued > 0;
    $("[data-price-progress]").hidden = !(pricing.active || pricing.queued || pricing.completed || pricing.errors || pricing.paused);
    $("[data-price-message]").textContent = pricing.active || pricing.queued ? `Checking listings · ${pricing.completed} finished` : `${pricing.completed} checked${pricing.errors ? ` · ${pricing.errors} need retry` : ""}${pricing.paused ? " · paused" : ""}`;
    $("[data-pause-prices]").hidden = !(pricing.active || pricing.queued);
    const finish = draft.items.length > 0 && !stats.pending && !session.preparing;
    $("[data-finish]").hidden = !finish;
    $("[data-save-summary]").textContent = session.saving ? `Saving ${session.saveProgress.done} of ${session.saveProgress.total}…` : stats.tapes ? `${stats.tapes} tape${stats.tapes === 1 ? "" : "s"} selected` : `${stats.saved} titles ${draft.destination === "scout" ? "saved to your scout list" : "added to your collection"}`;
    $("[data-save-detail]").textContent = stats.needsReview || stats.photoReviews ? [stats.needsReview ? `${stats.needsReview} titles to check` : "", stats.photoReviews ? `${stats.photoReviews} photos to check` : ""].filter(Boolean).join(" · ") : stats.errors ? "A photo couldn’t be read. Save these results, or retry it first." : stats.saved && !stats.tapes ? "Your finds are saved." : "Own them? Add to your shelf. Browsing? Keep a separate list.";
    const canSave = !session.saving && stats.tapes > 0 && !stats.needsReview && !stats.photoReviews;
    $("[data-save]").disabled = !canSave || draft.saveDestination === "scout";
    $("[data-save-scout]").disabled = !canSave || draft.saveDestination === "collection";
    $("[data-save]").innerHTML = `${icons.library} ${stats.saved && draft.destination !== "scout" && stats.tapes ? "Finish adding" : "Add to shelf"}`;
    $("[data-save-scout]").innerHTML = `${icons.search} ${stats.saved && draft.destination === "scout" && stats.tapes ? "Finish saving list" : "Just browsing"}`;
    $("[data-save-error]").hidden = !session.saveError; $("[data-save-error]").textContent = session.saveError;
    $("[data-enrich]").disabled = session.enriching || session.saving || !stats.tapes; $("[data-enrich-message]").textContent = session.enrichMessage || "Fill in missing posters, ratings and credits.";
    for (const [selector, value] of [["[data-asking]", draft.priceAsking], ["[data-paid]", draft.pricePaid], ["[data-location]", draft.location]]) { const input = $(selector); if (document.activeElement !== input) input.value = value ?? ""; input.disabled = session.saving; }
    const photoSelect = $("[data-manual-photo]");
    const options = `<option value="">No photo</option>${draft.photos.map((entry, index) => `<option value="${entry.id}">Photo ${index + 1}</option>`).join("")}`;
    if (photoSelect.dataset.options !== options) { const value = photoSelect.value || activePhotoId; photoSelect.innerHTML = options; photoSelect.value = value || ""; photoSelect.dataset.options = options; }
    $("[data-manual-form]").querySelectorAll("input,select,button").forEach((input) => { input.disabled = session.saving; });
    const announcement = `${stats.completed} of ${stats.photos} photos read. ${draft.items.length} titles. ${stats.needsReview} need checking.`;
    if (announcement !== lastAnnouncement) { $("[data-announcement]").textContent = announcement; lastAnnouncement = announcement; }
  }
  function addFiles(files) {
    if (!files?.length || session.saving) return;
    const { added, skipped } = session.addFiles(files);
    if (skipped) toast(`Added ${added} photos. A batch holds up to ${MAX_PHOTOS}.`, { duration: 4000 });
  }
  $("[data-camera]").onclick = () => $("[data-file-camera]").click(); $("[data-upload]").onclick = () => $("[data-file-library]").click();
  for (const selector of ["[data-file-camera]", "[data-file-library]"]) $(selector).onchange = (event) => { addFiles(Array.from(event.target.files)); event.target.value = ""; };
  const drop = $("[data-dropzone]"); drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("drag-over"); }; drop.ondragleave = () => drop.classList.remove("drag-over"); drop.ondrop = (event) => { event.preventDefault(); drop.classList.remove("drag-over"); addFiles(Array.from(event.dataTransfer.files)); };
  $("[data-mode]").onchange = (event) => { session.draft.mode = event.target.value; session.changed(); };
  $("[data-run]").onclick = () => {
    const stats = sessionSummary(session.draft);
    if (!session.draft.paused && stats.pending) session.pause();
    else {
      const errors = session.draft.photos.filter((photo) => photo.status === "error" && photo.image && (!photo.retryAfter || photo.retryAfter <= Date.now()));
      if (!stats.pending && !errors.length && stats.errors) { toast("Choose another photo, or wait a moment before retrying.", { error: true }); return; }
      errors.forEach((photo) => { photo.status = "queued"; photo.error = ""; }); session.resume();
    }
  };
  $("[data-expand]").onclick = showPhoto; $("[data-compare-count]").onclick = () => { compareCount = !compareCount; placement = null; update(); };
  $("[data-photo-confirm]").onchange = (event) => session.confirmPhoto(activePhotoId, event.target.checked);
  $("[data-add-dot]").onclick = () => beginPlacement(); $("[data-cancel-place]").onclick = () => { placement = null; update(); };
  $("[data-remove-photo]").onclick = () => session.removePhoto(activePhotoId); $("[data-retry-photo]").onclick = () => { const photo = activePhoto(); if (photo.retryAfter > Date.now()) toast("Wait a moment, then retry."); else session.retryPhoto(photo.id); };
  $("[data-manual-toggle]").onclick = () => { const form = $("[data-manual-form]"); form.hidden = !form.hidden; pendingMarker = null; placement = null; if (!form.hidden) { $("[data-manual-photo]").value = activePhotoId || ""; $("[data-manual-title]").focus(); } update(); };
  $("[data-manual-form]").onsubmit = (event) => {
    event.preventDefault(); const photoId = $("[data-manual-photo]").value;
    const item = session.addManual($("[data-manual-title]").value, photoId, pendingMarker?.photoId === photoId ? pendingMarker.marker : null);
    if (item) { pendingMarker = null; $("[data-manual-title]").value = ""; $("[data-manual-form]").hidden = true; selectItem(item.clientId, true); toast("Missed tape added."); }
  };
  $("[data-manual-photo]").onchange = () => { pendingMarker = null; };
  root.querySelectorAll("[data-filter]").forEach((button) => button.onclick = () => { filter = button.dataset.filter; visibleLimit = 50; update(); });
  $("[data-search]").oninput = (event) => { search = event.target.value.trim().toLowerCase(); visibleLimit = 50; update(); }; $("[data-more]").onclick = () => { visibleLimit += 50; update(); };
  $("[data-prices]").onclick = () => { const pricing = session.pricingSummary(); session.priceAll({ refresh: pricing.completed > 0 && pricing.completed === pricing.eligible }); }; $("[data-pause-prices]").onclick = () => session.pausePricing();
  $("[data-asking]").oninput = (event) => { session.draft.priceAsking = amount(event.target.value); session.changed(); }; $("[data-paid]").oninput = (event) => { session.draft.pricePaid = amount(event.target.value); session.changed(); }; $("[data-location]").oninput = (event) => { session.draft.location = event.target.value; session.changed(); }; $("[data-enrich]").onclick = () => session.enrich();
  async function save(destination) {
    session.draft.destination = destination;
    try { const { saved, scout } = await session.save((tapes) => { if (state.user?.id === userId) upsertTapes(tapes); }); if (alive(root, userId) && saved) toast(`${saved} title${saved === 1 ? "" : "s"} ${scout ? "saved to your browsing list" : "added to your shelf"}.`); }
    catch (error) { if (alive(root, userId)) toast(error.message, { error: true, duration: 4500 }); }
  }
  $("[data-save]").onclick = () => save("collection");
  $("[data-save-scout]").onclick = () => {
    if (session.draft.scoutListId) { save("scout"); return; }
    const { body, close } = openSheet({ title: "Save your browsing list", content: `<form class="account-form"><label for="scan-list-name">Store or list name</label><input class="text-field" id="scan-list-name" name="name" data-scout-name maxlength="120" placeholder="e.g. Saturday thrift store" value="${esc(session.draft.scoutName || "")}" /><p class="hint">These finds stay separate from the tapes you own.</p><button class="btn" type="submit">Save browsing list</button></form>` });
    body.querySelector("form").onsubmit = (event) => { event.preventDefault(); if (!alive(root, userId)) { close(); return; } session.draft.scoutName = body.querySelector("input").value; close(); save("scout"); };
  };
  $("[data-library]").onclick = () => { session.pause(); go("library", null, { replace: true }); };
  $("[data-new-batch]").onclick = () => {
    if (session.draft.items.some((item) => !isItemSaved(item)) || session.draft.photos.some((photo) => photo.status !== "complete")) {
      const { body, close } = openSheet({ title: "Start a fresh batch?", content: `<p class="hint">Saved finds stay in your account. This removes the current photos and unsaved titles from this device.</p><div class="stack mt-16"><button class="btn" data-confirm-reset>Start fresh</button><button class="btn gray" data-cancel-reset>Keep this draft</button></div>` });
      body.querySelector("[data-confirm-reset]").onclick = () => { close(); placement = null; pendingMarker = null; session.clear(); }; body.querySelector("[data-cancel-reset]").onclick = close;
    } else session.clear();
  };
  unsubscribe = session.subscribe(update); update();
}
