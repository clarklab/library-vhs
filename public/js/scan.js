import { icons } from "./icons.js";
import { openPhotoPreview } from "./photo-preview.js";
import { esc } from "./util.js";
import { openSheet, toast } from "./ui.js";
import { state, go, upsertTapes } from "./app.js";
import { openScanSession, MAX_PHOTOS, sessionSummary, duplicateWarnings, requiresReview, requiresPhotoReview, isItemSaved } from "./scan-session.js";

let unsubscribe;
let renderEpoch = 0;
const amount = (value) => value.trim() === "" ? null : Math.max(0, Number(value) || 0);
const alive = (root, userId) => root.isConnected && state.view === "scan" && state.user?.id === userId && root.querySelector("[data-scan-workspace]");

export async function renderScan(root) {
  const epoch = ++renderEpoch;
  unsubscribe?.();
  const userId = state.user?.id;
  root.innerHTML = `<div class="screen scan-screen"><div class="scan-loading" role="status"><span class="spinner"></span> Opening your scan workspace…</div></div>`;
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
  const requestedDestination = state.viewArg?.destination;
  if (["collection", "scout"].includes(requestedDestination) && !session.draft.items.some(isItemSaved)) {
    session.draft.destination = requestedDestination;
    session.changed();
  }
  let filter = "all";
  let search = "";
  let visibleLimit = 50;
  let lastAnnouncement = "";
  let manualOpen = false;

  root.innerHTML = `
    <div class="screen scan-screen" data-scan-workspace>
      <header class="scan-header">
        <div><p class="eyebrow">CAPTURE → REVIEW → COLLECT</p><h1>The scan studio<span class="accent-dot">.</span></h1><p class="scan-intro">A shelf full of tapes. A few good photos. Your collection, cataloged.</p></div>
        <div class="scan-header-actions"><span class="scan-draft-status" data-draft-status>${icons.check} Draft on this device</span><button class="btn gray" data-new-batch>New batch</button></div>
      </header>
      <div class="scan-storage-warning" data-storage-warning role="alert" hidden></div>
      <div class="scan-destination"><div><p class="eyebrow">WHERE SHOULD THESE GO?</p><div class="scan-destination-options" role="group" aria-label="Scan destination"><button data-destination="collection" class="active" aria-pressed="true">${icons.library}<span>My collection<small>Tapes you already own</small></span></button><button data-destination="scout" aria-pressed="false">${icons.search}<span>Scout list<small>Browsing? Save finds for later</small></span></button></div></div><label class="scan-scout-name" data-scout-name-wrap hidden>Store or list name<input class="text-field" data-scout-name placeholder="e.g. Saturday at Half Price Books" maxlength="120" /></label></div>
      <div class="scan-workspace">
        <section class="scan-capture" aria-labelledby="scan-capture-heading">
          <div class="scan-panel-heading"><span class="scan-step">01</span><div><h2 id="scan-capture-heading">Capture your shelf</h2><p>Up to 10 photos per batch</p></div><span class="scan-photo-count" data-photo-count>0 / 10</span></div>
          <div class="scan-dropzone" data-dropzone>
            <div class="scan-camera-art" aria-hidden="true">${icons.camera}<span>FRAME. SNAP. REPEAT.</span></div>
            <h3>A little closer. A lot clearer.</h3>
            <p>Photograph readable VHS spines or covers.<br>Give each tape one clear appearance.</p>
            <button class="btn" data-camera>${icons.camera} Take a photo</button>
            <button class="scan-upload-link" data-upload>${icons.photo} Choose photos <span>or drop them here</span></button>
            <input type="file" accept="image/*" capture="environment" hidden data-file-camera />
            <input type="file" accept="image/*" multiple hidden data-file-library />
          </div>
          <div class="scan-capture-tip">${icons.info}<p>Small, readable groups work best. Avoid glare and overlapping photos; you’ll review every uncertain title.</p></div>
          <div class="scan-mode"><label for="scan-mode">Reading mode</label><select id="scan-mode" data-mode><option value="fast">Everyday · quick shelf scans</option><option value="thorough">Careful · small or tricky labels</option></select><p>Careful mode spends longer on difficult photos.</p></div>
          <div class="scan-queue-header"><h3>Your photos</h3><span data-queue-status>No photos yet</span></div>
          <div class="scan-photo-list" data-photos></div>
          <button class="btn scan-run" data-run disabled>${icons.sparkles} Read photos</button>
          <p class="scan-queue-note" data-queue-note>Two photos at a time. Results arrive as each one finishes.</p>
        </section>
        <section class="scan-review" aria-labelledby="scan-review-heading">
          <div class="scan-panel-heading"><span class="scan-step">02</span><div><h2 id="scan-review-heading">Make it yours</h2><p>Check the titles, then file them away</p></div><span class="scan-result-count" data-result-count>0 tapes</span></div>
          <div class="scan-review-toolbar">
            <div class="scan-review-filters" role="group" aria-label="Filter recognized tapes"><button class="active" data-filter="all" aria-pressed="true">All <span data-count-all>0</span></button><button data-filter="review" aria-pressed="false">Needs review <span data-count-review>0</span></button><button data-filter="duplicates" aria-pressed="false">Possible repeats <span data-count-duplicates>0</span></button></div>
            <div class="scan-review-tools"><label class="scan-search">${icons.search}<input type="search" placeholder="Find a title in this batch" aria-label="Find a title in this batch" data-search /></label><button class="scan-text-button" data-manual-toggle>${icons.plus} Add a missed title</button></div>
          </div>
          <form class="scan-manual-form" data-manual-form hidden><label>Missed title<input class="text-field" data-manual-title placeholder="Type the title you can read" maxlength="300" required /></label><label>Source photo<select data-manual-photo aria-label="Source photo"><option value="">No photo</option></select></label><button class="btn" type="submit">Add title</button></form>
          <div class="scan-review-empty" data-empty><div class="scan-empty-reels" aria-hidden="true">${icons.tape}</div><p class="eyebrow">YOUR NEXT GREAT FIND STARTS HERE</p><h3>From shelf to collection.</h3><p>Add your photos on the left. Titles will appear here as they’re read, ready for a quick check.</p><div class="scan-empty-steps"><span><b>1</b> Capture</span><span><b>2</b> Review</span><span><b>3</b> Save</span></div></div>
          <div class="scan-review-notice" data-review-notice hidden></div>
          <div class="scan-review-list" data-items></div>
          <button class="btn gray scan-show-more" data-more hidden>Show more titles</button>
          <div class="scan-review-bottom" data-review-bottom hidden>
            <button class="scan-text-button" data-enrich>${icons.sparkles} Add film details <span>optional</span></button><p data-enrich-message>Titles save immediately. Cover art and film details are optional.</p>
            <details class="scan-bulk-details"><summary>Prices &amp; storage for this batch</summary><div class="scan-bulk-fields"><label>Asking price ($)<input type="number" min="0" step="0.01" inputmode="decimal" data-asking placeholder="0.00" /></label><label>Paid per tape ($)<input type="number" min="0" step="0.01" inputmode="decimal" data-paid placeholder="0.00" /></label><label>Storage location<input data-location maxlength="160" placeholder="e.g. Shelf A / Box 07" /></label></div></details>
          </div>
        </section>
      </div>
      <footer class="scan-savebar"><div class="scan-save-summary"><strong data-save-summary>Your collection starts with a photo</strong><span data-save-detail>Your draft is kept on this device.</span></div><div class="scan-save-actions"><button class="btn gray" data-library>Back to collection</button><button class="btn" data-save disabled>${icons.check} Save to collection</button></div><p class="scan-save-error" data-save-error role="alert" hidden></p></footer>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-announcement></div>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const photoList = $("[data-photos]");
  const itemList = $("[data-items]");
  const photoNodes = new Map();
  const itemNodes = new Map();
  const photoSignatures = new Map();

  function showPhoto(id) {
    const photo = session.draft.photos.find((p) => p.id === id);
    if (!photo?.image) return;
    const n = session.draft.photos.indexOf(photo) + 1;
    const titles = photo.initialResult?.tapes || session.draft.items.filter((i) => i.photoId === id);
    openPhotoPreview({ photo, number: n, titles });
  }

  function updatePhotos(draft) {
    for (const [id, node] of photoNodes) if (!draft.photos.some((p) => p.id === id)) { node.remove(); photoNodes.delete(id); photoSignatures.delete(id); }
    draft.photos.forEach((photo, index) => {
      let node = photoNodes.get(photo.id);
      if (!node) {
        node = document.createElement("article");
        node.className = "scan-photo-card";
        photoNodes.set(photo.id, node);
        photoList.append(node);
      }
      const count = photo.status === "processing" && photo.initialResult ? photo.initialResult.tapes.length : draft.items.filter((i) => i.photoId === photo.id).length;
      const signature = JSON.stringify([index, photo.status, photo.error, count, photo.notes, photo.warnings, photo.image.length, photo.stage, photo.verification, photo.verificationError, photo.reviewed, session.saving]);
      if (photoSignatures.get(photo.id) === signature) return;
      photoSignatures.set(photo.id, signature);
      const status = { preparing: "Preparing image…", queued: "Ready to read", processing: photo.stage === "verifying" ? "Taking a closer look…" : "Counting + reading…", complete: `${count} title${count === 1 ? "" : "s"} found`, error: "Needs another try" }[photo.status];
      node.dataset.status = photo.status;
      node.innerHTML = `<button class="scan-photo-thumb" data-preview aria-label="View photo ${index + 1}" ${photo.image ? "" : "disabled"}>${photo.image ? `<img src="${photo.image}" alt="" loading="lazy" />` : icons.photo}<span>${String(index + 1).padStart(2, "0")}</span></button><div class="scan-photo-body"><strong>Photo ${String(index + 1).padStart(2, "0")}</strong><p class="scan-photo-status">${photo.status === "processing" || photo.status === "preparing" ? '<span class="spinner"></span>' : ""}${esc(status)}</p>${photo.error ? `<p class="scan-photo-error">${esc(photo.error)}</p>` : ""}${photo.status === "complete" && !count ? '<p class="scan-photo-error">Try a closer photo, or add the titles manually.</p>' : ""}${photo.verification ? `<p class="scan-photo-coverage">${photo.verification.countedCount ?? "?"} counted · ${count} listed${photo.verification.stage === "reviewed" ? " · Double-checked" : ""}</p>` : ""}${photo.verificationError ? `<p class="scan-photo-error">${esc(photo.verificationError)}</p>` : ""}${photo.needsPhotoReview ? `<label class="scan-photo-confirm"><input type="checkbox" data-photo-confirm ${photo.reviewed ? "checked" : ""} ${session.saving ? "disabled" : ""}/><span>I checked this photo and accounted for every tape</span></label><p class="scan-photo-note">Counts can be wrong. Compare the photo, add missed titles, then confirm.</p>` : ""}${photo.notes ? `<p class="scan-photo-note">${esc(photo.notes)}</p>` : ""}${(photo.warnings || []).map((w) => `<p class="scan-photo-note">${esc(typeof w === "string" ? w : w.message)}</p>`).join("")}</div><div class="scan-photo-actions">${photo.status === "error" && photo.image ? '<button class="scan-text-button" data-retry>Retry</button>' : ""}<button class="nav-btn" data-remove aria-label="Remove photo ${index + 1} and its unsaved titles" ${session.saving ? "disabled" : ""}>${icons.close}</button></div>`;
      node.querySelector("[data-photo-confirm]")?.addEventListener("change", (event) => session.confirmPhoto(photo.id, event.target.checked));
      node.querySelector("[data-preview]").onclick = () => showPhoto(photo.id);
      node.querySelector("[data-remove]").onclick = () => session.removePhoto(photo.id);
      node.querySelector("[data-retry]")?.addEventListener("click", () => {
        if (photo.retryAfter > Date.now()) { toast(`Please wait ${Math.ceil((photo.retryAfter - Date.now()) / 1000)} seconds before retrying.`, { error: true }); return; }
        session.retryPhoto(photo.id);
      });
    });
  }

  function createItem(item) {
    const node = document.createElement("article");
    node.className = "scan-item";
    node.dataset.itemId = item.clientId;
    node.innerHTML = `<div class="scan-item-top"><label class="scan-item-include"><input type="checkbox" data-include aria-label="Include this tape" /><span data-item-number></span></label><button class="scan-source-link" data-source></button><span class="scan-confidence" data-confidence></span></div><div class="scan-item-fields"><label class="scan-title-field"><span>Title</span><input data-title maxlength="300" aria-label="Tape title" /></label><label class="scan-year-field"><span>Year</span><input data-year type="number" min="1888" max="2100" inputmode="numeric" placeholder="—" aria-label="Release year" /></label><label class="scan-format-field"><span>Format</span><select data-format aria-label="Media format"><option value="unknown">Confirm format</option><option value="VHS">VHS</option><option value="DVD">DVD</option><option value="CD">CD</option><option value="Blu-ray">Blu-ray</option><option value="other">Other</option></select></label><label class="scan-edition-field"><span>Edition</span><input data-edition maxlength="200" placeholder="Optional" aria-label="Tape edition" /></label></div><p class="scan-item-meta" data-meta></p><div class="scan-warning" data-warning hidden></div><label class="scan-confirm" data-confirm-wrap><input type="checkbox" data-confirm /><span>I checked this title against the photo</span></label>`;
    node.querySelector("[data-include]").onchange = (e) => session.updateItem(item.clientId, { include: e.target.checked });
    node.querySelector("[data-title]").oninput = (e) => session.updateItem(item.clientId, { title: e.target.value, confirmed: false, matched: false });
    node.querySelector("[data-year]").oninput = (e) => session.updateItem(item.clientId, { year: e.target.value ? Number(e.target.value) : null });
    node.querySelector("[data-format]").onchange = (e) => session.updateItem(item.clientId, { format: e.target.value });
    node.querySelector("[data-edition]").oninput = (e) => session.updateItem(item.clientId, { edition: e.target.value });
    node.querySelector("[data-confirm]").onchange = (e) => session.updateItem(item.clientId, { confirmed: e.target.checked });
    node.querySelector("[data-source]").onclick = () => showPhoto(item.photoId);
    return node;
  }

  function update() {
    if (!alive(root, userId)) return;
    const draft = session.draft;
    const stats = sessionSummary(draft);
    const scouting = draft.destination === "scout";
    root.querySelectorAll("[data-destination]").forEach((button) => {
      const selected = button.dataset.destination === (draft.destination || "collection");
      button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected));
      button.disabled = session.saving || stats.saved > 0;
    });
    $("[data-scout-name-wrap]").hidden = !scouting;
    if (document.activeElement !== $("[data-scout-name]")) $("[data-scout-name]").value = draft.scoutName || "";
    $("[data-scout-name]").disabled = session.saving || stats.saved > 0;
    const duplicates = duplicateWarnings(draft.items, state.tapes);
    $("[data-photo-count]").textContent = `${stats.photos} / ${MAX_PHOTOS}`;
    $("[data-result-count]").textContent = `${draft.items.length} tape${draft.items.length === 1 ? "" : "s"}`;
    $("[data-count-all]").textContent = draft.items.length;
    $("[data-count-review]").textContent = stats.needsReview;
    $("[data-count-duplicates]").textContent = duplicates.size;
    $("[data-storage-warning]").hidden = !session.storageError;
    $("[data-storage-warning]").textContent = session.storageError;
    $("[data-draft-status]").innerHTML = session.storageError ? `${icons.info} Draft not backed up` : `${icons.check} Draft on this device`;
    $("[data-mode]").value = draft.mode;
    $("[data-mode]").disabled = session.saving;
    $("[data-camera]").disabled = $("[data-upload]").disabled = stats.photos >= MAX_PHOTOS || session.saving;
    $("[data-new-batch]").disabled = session.saving || session.preparing > 0 || (!stats.photos && !draft.items.length);
    $("[data-queue-status]").textContent = stats.photos ? `${stats.completed} of ${stats.photos} read` : "No photos yet";
    const run = $("[data-run]");
    const running = !draft.paused && stats.pending > 0;
    run.disabled = (!stats.pending && !stats.errors) || session.saving;
    run.innerHTML = running ? "Pause reading" : `${icons.sparkles} ${stats.pending ? (stats.completed ? "Resume reading" : `Read ${stats.pending} photo${stats.pending === 1 ? "" : "s"}`) : stats.errors ? "Retry failed photos" : stats.photos ? "All photos read" : "Read photos"}`;
    $("[data-queue-note]").textContent = running ? "Reading two photos at a time. You can review titles as they arrive." : stats.pending && stats.completed ? "Paused. Your photos and reviewed titles are kept here." : "Two photos at a time. Results arrive as each one finishes.";
    updatePhotos(draft);

    const matching = draft.items.filter((item) => {
      if (search && !item.title.toLowerCase().includes(search)) return false;
      return filter === "review" ? requiresReview(item) : filter === "duplicates" ? duplicates.has(item.clientId) : true;
    });
    const shown = matching.slice(0, visibleLimit);
    const showIds = new Set(shown.map((i) => i.clientId));
    for (const [id, node] of itemNodes) if (!showIds.has(id)) { node.remove(); itemNodes.delete(id); }
    shown.forEach((item, index) => {
      let node = itemNodes.get(item.clientId);
      if (!node) { node = createItem(item); itemNodes.set(item.clientId, node); itemList.append(node); }
      if (itemList.children[index] !== node) itemList.insertBefore(node, itemList.children[index] || null);
      node.className = `scan-item${requiresReview(item) ? " needs-review" : ""}${item.include === false ? " excluded" : ""}${isItemSaved(item) ? " saved" : ""}`;
      const input = (selector, value) => { const el = node.querySelector(selector); if (document.activeElement !== el) el.value = value ?? ""; };
      input("[data-format]", item.format || "unknown"); input("[data-title]", item.title); input("[data-year]", item.year); input("[data-edition]", item.edition);
      node.querySelector("[data-include]").checked = item.include !== false;
      node.querySelector("[data-confirm]").checked = Boolean(item.confirmed);
      node.querySelector("[data-item-number]").textContent = String(draft.items.indexOf(item) + 1).padStart(2, "0");
      node.querySelectorAll("input,select").forEach((el) => { el.disabled = Boolean(isItemSaved(item) || session.saving); });
      const photoIndex = draft.photos.findIndex((p) => p.id === item.photoId);
      const source = node.querySelector("[data-source]");
      source.textContent = photoIndex >= 0 ? `Photo ${String(photoIndex + 1).padStart(2, "0")}${item.sourceIndex ? ` · Tape ${item.sourceIndex}` : ""}` : "Manually added";
      source.disabled = photoIndex < 0;
      const badge = node.querySelector("[data-confidence]");
      badge.textContent = isItemSaved(item) ? "Saved" : item.format === "unknown" ? "Check format" : item.needsReview ? (item.confirmed ? "Checked" : "Check title") : item.confidence === "manual" ? "Added by you" : "Clear read";
      badge.dataset.confidence = isItemSaved(item) ? "high" : requiresReview(item) ? "low" : "high";
      node.querySelector("[data-confirm-wrap]").hidden = !item.needsReview || item.include === false || Boolean(isItemSaved(item));
      const meta = node.querySelector("[data-meta]");
      meta.textContent = [item.visual, item.director, item.genre].filter(Boolean).join(" · ");
      meta.hidden = !meta.textContent;
      const warning = node.querySelector("[data-warning]");
      const duplicate = duplicates.get(item.clientId);
      warning.hidden = !duplicate;
      warning.textContent = duplicate ? `${duplicate.batch ? `Also appears ${duplicate.batch} more time${duplicate.batch === 1 ? "" : "s"} in this batch. ` : ""}${duplicate.library ? `${duplicate.library} matching title${duplicate.library === 1 ? "" : "s"} in your collection. ` : ""}Keep selected for a separate physical copy; uncheck if it’s the same tape.` : "";
    });
    $("[data-empty]").hidden = draft.items.length > 0;
    $("[data-review-notice]").hidden = !draft.items.length || matching.length > 0;
    $("[data-review-notice]").textContent = filter === "review" ? "All selected titles checked. Ready when you are." : "No titles match this view.";
    $("[data-more]").hidden = matching.length <= shown.length;
    $("[data-more]").textContent = `Show more titles (${shown.length} of ${matching.length})`;
    $("[data-review-bottom]").hidden = !draft.items.length;
    $("[data-enrich]").disabled = session.enriching || session.saving || !stats.tapes;
    $("[data-enrich-message]").textContent = session.enrichMessage || "Titles save immediately. Cover art and film details are optional.";
    $("[data-save-summary]").textContent = session.saving ? `Saving ${session.saveProgress.done} of ${session.saveProgress.total}…` : stats.tapes ? `${stats.tapes} tape${stats.tapes === 1 ? "" : "s"} selected${stats.saved ? ` · ${stats.saved} saved` : ""}` : stats.saved ? `${stats.saved} titles ${scouting ? "saved to your scout list" : "added to your collection"}` : "Your collection starts with a photo";
    $("[data-save-detail]").textContent = (stats.needsReview || stats.photoReviews) ? [stats.needsReview ? `${stats.needsReview} titles to check` : "", stats.photoReviews ? `${stats.photoReviews} photos to account for` : ""].filter(Boolean).join(" · ") : stats.pending ? "You can save reviewed titles while other photos are waiting." : scouting ? "Your scout list stays separate from the tapes you own." : "Each selected title becomes a separate tape in your collection.";
    $("[data-save]").disabled = session.saving || !stats.tapes || stats.needsReview > 0 || stats.photoReviews > 0;
    $("[data-save]").innerHTML = session.saving ? '<span class="spinner"></span> Saving…' : `${icons.check} Save ${stats.tapes || ""} to ${scouting ? "scout list" : "collection"}`;
    $("[data-save-error]").hidden = !session.saveError;
    $("[data-save-error]").textContent = session.saveError;
    $("[data-manual-toggle]").disabled = session.saving;
    $("[data-manual-form]").querySelectorAll("input,select,button").forEach((el) => { el.disabled = session.saving; });
    for (const [selector, value] of [["[data-asking]", draft.priceAsking], ["[data-paid]", draft.pricePaid], ["[data-location]", draft.location]]) {
      const el = $(selector); if (document.activeElement !== el) el.value = value ?? ""; el.disabled = session.saving;
    }
    const photoSelect = $("[data-manual-photo]");
    const options = `<option value="">No photo</option>${draft.photos.map((p, i) => `<option value="${p.id}">Photo ${String(i + 1).padStart(2, "0")}</option>`).join("")}`;
    if (photoSelect.dataset.options !== options) { const value = photoSelect.value; photoSelect.innerHTML = options; photoSelect.value = value; photoSelect.dataset.options = options; }
    const announcement = `${stats.completed} of ${stats.photos} photos read. ${stats.tapes} titles selected. ${stats.needsReview} need review. ${stats.photoReviews} photos need a count check.${stats.errors ? ` ${stats.errors} photos need another try.` : ""}`;
    if (announcement !== lastAnnouncement) { $("[data-announcement]").textContent = announcement; lastAnnouncement = announcement; }
  }

  function addFiles(files) {
    if (!files?.length || session.saving) return;
    const { added, skipped } = session.addFiles(files);
    if (skipped) toast(`Added ${added} photos. A batch holds up to ${MAX_PHOTOS}; save this batch before starting another.`, { duration: 4500 });
  }
  $("[data-camera]").onclick = () => $("[data-file-camera]").click();
  $("[data-upload]").onclick = () => $("[data-file-library]").click();
  for (const selector of ["[data-file-camera]", "[data-file-library]"]) $(selector).onchange = (event) => { addFiles(Array.from(event.target.files)); event.target.value = ""; };
  const drop = $("[data-dropzone]");
  drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("drag-over"); };
  drop.ondragleave = () => drop.classList.remove("drag-over");
  drop.ondrop = (event) => { event.preventDefault(); drop.classList.remove("drag-over"); addFiles(Array.from(event.dataTransfer.files)); };
  root.querySelectorAll("[data-destination]").forEach((button) => button.onclick = () => { session.draft.destination = button.dataset.destination; session.changed(); });
  $("[data-scout-name]").oninput = (event) => { session.draft.scoutName = event.target.value; session.changed(); };
  $("[data-mode]").onchange = (event) => { session.draft.mode = event.target.value; session.changed(); };
  $("[data-run]").onclick = () => {
    const stats = sessionSummary(session.draft);
    if (!session.draft.paused && stats.pending) session.pause();
    else {
      const readyErrors = session.draft.photos.filter((p) => p.status === "error" && p.image && (!p.retryAfter || p.retryAfter <= Date.now()));
      if (!stats.pending && !readyErrors.length && stats.errors) { toast("Choose another photo, or wait a moment before retrying.", { error: true }); return; }
      readyErrors.forEach((p) => { p.status = "queued"; p.error = ""; });
      session.resume();
    }
  };
  root.querySelectorAll("[data-filter]").forEach((button) => button.onclick = () => {
    filter = button.dataset.filter; visibleLimit = 50;
    root.querySelectorAll("[data-filter]").forEach((other) => { other.classList.toggle("active", other === button); other.setAttribute("aria-pressed", String(other === button)); });
    update();
  });
  $("[data-search]").oninput = (event) => { search = event.target.value.trim().toLowerCase(); visibleLimit = 50; update(); };
  $("[data-more]").onclick = () => { visibleLimit += 50; update(); };
  $("[data-manual-toggle]").onclick = () => { manualOpen = !manualOpen; $("[data-manual-form]").hidden = !manualOpen; if (manualOpen) $("[data-manual-title]").focus(); };
  $("[data-manual-form]").onsubmit = (event) => {
    event.preventDefault();
    const item = session.addManual($("[data-manual-title]").value, $("[data-manual-photo]").value);
    if (item) { $("[data-manual-title]").value = ""; $("[data-manual-title]").focus(); toast("Title added to this batch."); }
  };
  $("[data-asking]").oninput = (event) => { session.draft.priceAsking = amount(event.target.value); session.changed(); };
  $("[data-paid]").oninput = (event) => { session.draft.pricePaid = amount(event.target.value); session.changed(); };
  $("[data-location]").oninput = (event) => { session.draft.location = event.target.value; session.changed(); };
  $("[data-enrich]").onclick = () => session.enrich();
  $("[data-save]").onclick = async () => {
    try {
      const { saved, scout } = await session.save((tapes) => { if (state.user?.id === userId) upsertTapes(tapes); });
      if (alive(root, userId) && saved) toast(`${saved} title${saved === 1 ? "" : "s"} ${scout ? "saved to your scout list" : "added to your collection"}.`);
    } catch (error) { if (alive(root, userId)) toast(error.message, { error: true, duration: 4500 }); }
  };
  $("[data-library]").onclick = () => { session.pause(); go("library", null, { replace: true }); };
  $("[data-new-batch]").onclick = () => {
    const unsaved = session.draft.items.some((i) => !isItemSaved(i)) || session.draft.photos.some((p) => p.status !== "complete");
    if (unsaved) {
      const { close } = openSheet({ title: "Start a fresh batch?", content: `<p class="hint">Your saved tapes stay in the collection. This removes the photos and unsaved titles from this device’s current draft.</p><div class="stack mt-16"><button class="btn" data-confirm-reset>Start fresh</button><button class="btn gray" data-cancel-reset>Keep this draft</button></div>` });
      document.querySelector("[data-confirm-reset]").onclick = () => { close(); session.clear({ destination: requestedDestination }); };
      document.querySelector("[data-cancel-reset]").onclick = close;
    } else session.clear({ destination: requestedDestination });
  };
  unsubscribe = session.subscribe(update);
  update();
}
