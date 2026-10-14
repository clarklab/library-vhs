import { api, getToken } from "./api.js";
import { state, go, upsertTapes } from "./app.js";
import { esc } from "./util.js";
import { marketLabel, marketMeta, marketEvidence } from "./market-view.js";
import { estimateSubject } from "./scan-session.js";
import { icons } from "./icons.js";
import { toast, confirmSheet, openSheet } from "./ui.js";
import { soldListingUrl, scoutPurchasePayload } from "./scout-utils.js";

const dateLabel = (value) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const isUnknown = (item) => !item.title?.trim() || /^(unknown|unreadable|unidentified)(\b|$)/i.test(item.title) || ["Other", "other", "unknown"].includes(item.format);
const SCOUT_RENDER = Symbol("scout-render");

export async function renderScouts(root) {
  const userId = state.user?.id;
  const requestOptions = { expectedToken: getToken() };
  const requestedListId = state.viewArg ?? null;
  const renderToken = Symbol("scout-view");
  root[SCOUT_RENDER] = renderToken;
  const sameUser = () => state.user?.id === userId && getToken() === requestOptions.expectedToken;
  const visible = () => sameUser() && state.view === "scouts" && (state.viewArg ?? null) === requestedListId && root.isConnected && root[SCOUT_RENDER] === renderToken;
  root.innerHTML = `<div class="screen scouts-screen"><div class="scan-loading" role="status"><span class="spinner"></span> Opening your scout lists…</div></div>`;
  try {
    if (requestedListId) {
      const { list } = await api.getScout(requestedListId, requestOptions);
      if (visible()) showDetail(list);
    } else {
      const { lists } = await api.listScouts(requestOptions);
      if (!visible()) return;
      root.innerHTML = `<div class="screen scouts-screen"><header class="scouts-header"><div><p class="eyebrow">SPOT THE FIND. MAKE THE CALL.</p><h1>Your scout lists<span class="accent-dot">.</span></h1><p>Keep shop visits and possible finds separate from the media you own.</p></div><button class="btn" data-scan>${icons.camera} Scout a shelf</button></header><div class="scout-disclaimer">Check current listings before you buy. Asking prices and sold evidence are labeled separately; match the format, edition and condition to the tape in your hand.</div>${lists.length ? `<div class="scouts-grid">${lists.map((list) => `<button class="scout-list-card" data-open="${esc(list.id)}"><span class="eyebrow">${list.photoCount} SOURCE ${list.photoCount === 1 ? "PHOTO" : "PHOTOS"}</span><h2>${esc(list.name)}</h2><p>${list.itemCount} items <span>·</span> ${list.purchasedCount} collected</p><div class="scout-summary"><span>${list.worthCheckingCount} worth checking</span><span>${esc(dateLabel(list.updatedAt))} ↗</span></div></button>`).join("")}</div>` : `<section class="empty"><div class="empty-icon">${icons.camera}</div><h3>A good find starts here.</h3><p>Scan a shelf of VHS tapes, then save the review as a scout list. Your collection stays separate until you buy.</p><button class="btn" data-scan>Start scouting</button></section>`}</div>`;
      root.querySelectorAll("[data-scan]").forEach((button) => button.addEventListener("click", () => go("scan", { destination: "scout" })));
      root.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => go("scouts", button.dataset.open)));
    }
  } catch (error) {
    if (!visible()) return;
    root.innerHTML = `<div class="screen scouts-screen"><div class="scout-error" role="alert">${esc(error.message)}</div><button class="btn gray" data-retry>Try again</button><button class="btn gray" data-back>All scout lists</button></div>`;
    root.querySelector("[data-retry]").addEventListener("click", () => renderScouts(root));
    root.querySelector("[data-back]").addEventListener("click", () => go("scouts"));
  }

  function showDetail(initial) {
    let list = initial;
    let busy = false;
    let filter = "all";
    let query = "";
    let limit = 40;
    let message = "";
    let estimateController = null;
    const selected = new Set();
    const rowErrors = new Map();
    const ownId = (item) => item.purchasedTapeId || state.tapes.find((tape) => tape.clientId === item.clientId)?.id;
    const filteredItems = () => {
      const photos = new Map((list.photos || []).map((photo, index) => [photo.id, index]));
      return list.items.filter((item) => (
        (!query || `${item.title} ${item.artist || ""} ${item.format} ${item.edition}`.toLowerCase().includes(query.toLowerCase())) &&
        (filter !== "check" || item.estimate?.worthChecking) &&
        (filter !== "unbought" || !ownId(item))
      )).sort((a, b) => (photos.get(a.photoId) ?? 999) - (photos.get(b.photoId) ?? 999) || (a.sourceIndex || 0) - (b.sourceIndex || 0));
    };
    root.innerHTML = `<div class="screen scouts-screen"><header class="scout-detail-header"><button class="btn gray" data-back>← Scout lists</button><div><p class="eyebrow">YOUR NEXT POSSIBLE FINDS</p><h1 data-title></h1><p data-list-summary></p></div><div class="scout-header-actions"><button class="btn gray" data-rename>Rename</button><button class="btn gray" data-delete>Delete list</button></div></header><div class="scout-disclaimer"><strong>Prices with sources.</strong> Current web checks show matching listings, check dates and whether prices are asking or sold. Old AI estimates stay labeled. “Worth checking” is a price signal, not proof of rarity. Source photo labels are saved; original photos remain on the capture device.</div><div class="scout-toolbar"><label class="searchbar">${icons.search}<input type="search" placeholder="Find a title, format or edition" aria-label="Search scout list" data-search /></label><select data-filter aria-label="Filter scout list"><option value="all">All finds</option><option value="check">Worth checking</option><option value="unbought">Not collected</option></select><button class="btn gray" data-select>Select visible</button></div><div class="scout-batch-actions"><span data-selected>0 selected</span><button class="btn gray" data-estimate disabled>${icons.sparkles} Check selected prices</button><button class="btn gray" data-stop-estimates hidden>Pause checks</button><button class="btn" data-purchase disabled>${icons.plus} Add purchased to collection</button></div><p class="scout-status" data-status role="status" aria-live="polite"></p><div class="scout-items" data-items></div><button class="btn gray" data-more hidden>Show more items</button></div>`;
    root.querySelector("[data-back]").addEventListener("click", () => go("scouts"));
    root.querySelector("[data-search]").addEventListener("input", (event) => { query = event.target.value; limit = 40; paint(); });
    root.querySelector("[data-filter]").addEventListener("change", (event) => { filter = event.target.value; limit = 40; paint(); });
    root.querySelector("[data-more]").addEventListener("click", () => { limit += 40; paint(); });
    root.querySelector("[data-select]").addEventListener("click", () => {
      const candidates = filteredItems().slice(0, limit).filter((item) => !ownId(item));
      const clear = candidates.length && candidates.every((item) => selected.has(item.clientId));
      for (const item of candidates) clear ? selected.delete(item.clientId) : selected.add(item.clientId);
      paint();
    });
    root.querySelector("[data-rename]").addEventListener("click", async () => {
      if (busy) return;
      const { body, close } = openSheet({
        title: "Name this scout list",
        content: `<form class="stack" data-rename-form><label>List name<input class="text-field" name="name" maxlength="120" value="${esc(list.name)}" required /></label><button class="btn" type="submit">Save name</button></form>`,
      });
      body.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = body.querySelector("input").value.trim();
        if (!name || busy) return;
        await run(async () => { ({ list } = await api.updateScout(list.id, { name }, requestOptions)); close(); });
      });
    });
    root.querySelector("[data-delete]").addEventListener("click", async () => {
      if (busy) return;
      const confirmed = await confirmSheet({ title: "Delete this scout list?", message: "The list and its estimates will be removed. Items already added to your collection stay there.", confirmLabel: "Delete scout list" });
      if (!confirmed || !sameUser()) return;
      await run(async () => { await api.deleteScout(list.id, requestOptions); if (visible()) go("scouts"); });
    });
    root.querySelector("[data-estimate]").addEventListener("click", () => estimate(list.items.filter((item) => selected.has(item.clientId))));
    root.querySelector("[data-stop-estimates]").addEventListener("click", () => {
      estimateController?.abort();
      message = "Pausing price checks. Completed results are kept.";
      paint();
    });
    root.querySelector("[data-purchase]").addEventListener("click", () => purchase(list.items.filter((item) => selected.has(item.clientId))));

    function paint() {
      if (!visible()) return;
      root.querySelector("[data-title]").textContent = list.name;
      root.querySelector("[data-list-summary]").textContent = `${list.items.length} items · ${list.items.filter(ownId).length} in your collection · ${list.photos?.length || 0} source photos`;
      root.querySelector("[data-selected]").textContent = `${selected.size} selected`;
      root.querySelector("[data-estimate]").disabled = busy || !selected.size;
      root.querySelector("[data-stop-estimates]").hidden = !estimateController;
      root.querySelector("[data-stop-estimates]").disabled = estimateController?.signal.aborted === true;
      root.querySelector("[data-purchase]").disabled = busy || !selected.size;
      root.querySelector("[data-select]").disabled = busy;
      root.querySelector("[data-rename]").disabled = busy;
      root.querySelector("[data-delete]").disabled = busy;
      root.querySelector("[data-status]").textContent = message || "Select finds to check prices or add the ones you purchased.";
      const items = filteredItems();
      const photos = new Map((list.photos || []).map((photo, index) => [photo.id, { ...photo, index: index + 1 }]));
      root.querySelector("[data-items]").innerHTML = items.slice(0, limit).map((item) => {
        const owned = ownId(item);
        const photo = photos.get(item.photoId);
        const estimate = item.estimate;
        return `<article class="scout-item${estimate?.worthChecking ? " scout-watch" : ""}"><label class="scout-item-select"><input type="checkbox" data-select-item="${esc(item.clientId)}" aria-label="Select ${esc(item.title)}" ${selected.has(item.clientId) ? "checked" : ""} ${busy || owned ? "disabled" : ""} /></label><div class="scout-item-main"><div class="scout-item-meta"><span>${esc(item.format)}</span>${photo ? `<span>Photo ${photo.index}${item.sourceIndex ? ` · item ${item.sourceIndex}` : ""}</span>` : ""}${owned ? '<span class="scout-collected">In collection</span>' : ""}${estimate?.worthChecking ? '<span class="scout-check-label">Worth checking</span>' : ""}</div><h3>${esc(item.title)}${item.year ? ` <small>(${esc(item.year)})</small>` : ""}</h3>${item.artist || item.edition ? `<p>${esc([item.artist, item.edition].filter(Boolean).join(" · "))}</p>` : ""}${item.visual ? `<p class="scout-source-note">${esc(item.visual)}</p>` : ""}${marketEvidence(estimate)}${rowErrors.has(item.clientId) ? `<p class="scout-error" role="alert">${esc(rowErrors.get(item.clientId))}</p>` : ""}</div><div class="scout-item-value"><strong>${esc(marketLabel(estimate))}</strong><span>${esc(marketMeta(estimate))}</span></div><div class="scout-item-actions"><button class="btn gray" data-edit-item="${esc(item.clientId)}" ${busy ? "disabled" : ""}>Edit</button><a class="btn gray" href="${esc(soldListingUrl(item))}" target="_blank" rel="noopener noreferrer">Sold listings ↗</a><button class="btn gray" data-estimate-item="${esc(item.clientId)}" ${busy || isUnknown(item) ? "disabled" : ""}>${estimate ? "Refresh prices" : "Check prices"}</button>${owned ? `<button class="btn gray" data-owned="${esc(owned)}">View in collection</button>${!item.purchasedTapeId ? `<button class="btn gray" data-purchase-item="${esc(item.clientId)}" ${busy ? "disabled" : ""}>Finish adding</button>` : ""}` : `<button class="btn gray" data-purchase-item="${esc(item.clientId)}" ${busy || isUnknown(item) ? "disabled" : ""}>I bought this</button>`}</div></article>`;
      }).join("") || '<p class="empty">No items match this filter.</p>';
      root.querySelector("[data-more]").hidden = items.length <= limit;
      root.querySelectorAll("[data-select-item]").forEach((input) => input.addEventListener("change", () => { input.checked ? selected.add(input.dataset.selectItem) : selected.delete(input.dataset.selectItem); paint(); }));
      root.querySelectorAll("[data-estimate-item]").forEach((button) => button.addEventListener("click", () => estimate([list.items.find((item) => item.clientId === button.dataset.estimateItem)])));
      root.querySelectorAll("[data-purchase-item]").forEach((button) => button.addEventListener("click", () => purchase([list.items.find((item) => item.clientId === button.dataset.purchaseItem)])));
      root.querySelectorAll("[data-edit-item]").forEach((button) => button.addEventListener("click", () => editItem(list.items.find((item) => item.clientId === button.dataset.editItem))));
      root.querySelectorAll("[data-owned]").forEach((button) => button.addEventListener("click", () => go("detail", button.dataset.owned)));
    }
    function editItem(item) {
      if (busy || !visible()) return;
      const { body, close } = openSheet({
        title: "Edit this find",
        content: `<form class="stack" data-edit-scout-form><label>Title<input class="text-field" name="title" maxlength="300" value="${esc(item.title)}" required /></label><label>Format<select class="text-field" name="format">${["VHS", "DVD", "CD", "Blu-ray", "Other"].map((format) => `<option ${item.format === format ? "selected" : ""}>${format}</option>`).join("")}</select></label><label>Release year<input class="text-field" type="number" name="year" min="1888" max="2100" value="${esc(item.year ?? "")}" placeholder="Unknown" /></label><label>Edition<input class="text-field" name="edition" maxlength="200" value="${esc(item.edition || "")}" placeholder="Details printed on the case" /></label><label>Artist <span class="hint">for music</span><input class="text-field" name="artist" maxlength="200" value="${esc(item.artist || "")}" /></label><label>Visible evidence<input class="text-field" name="visual" maxlength="200" value="${esc(item.visual || "")}" placeholder="e.g. top shelf, third from the left" /></label><p class="hint">Changing the identification clears its old estimate.${ownId(item) ? " This edits the scout list; use the collection to edit your owned copy." : ""}</p><p class="scout-error" data-edit-error role="alert" hidden></p><button class="btn" type="submit">Save changes</button></form>`,
      });
      body.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || !visible()) return;
        const fields = new FormData(event.currentTarget);
        const patch = Object.fromEntries(["title", "format", "edition", "artist", "visual"].map((field) => [field, String(fields.get(field) || "").trim()]));
        patch.year = fields.get("year") === "" ? null : Number(fields.get("year"));
        await run(async () => {
          try {
            ({ list } = await api.updateScout(list.id, { items: [{ clientId: item.clientId, ...patch }] }, requestOptions));
            rowErrors.delete(item.clientId);
            close();
            message = "Find updated. Check current prices when its title and format are identified.";
          } catch (error) {
            const notice = body.querySelector("[data-edit-error]");
            notice.textContent = error.message; notice.hidden = false;
            throw error;
          }
        });
      });
    }
    async function run(action) {
      if (busy || !visible()) return;
      busy = true; message = ""; paint();
      try { await action(); }
      catch (error) { if (sameUser()) { message = error.message; toast(error.message, { error: true, duration: 5000 }); } }
      finally { busy = false; paint(); }
    }
    async function estimate(items) {
      if (!items.length || busy) return;
      await run(async () => {
        const controller = new AbortController();
        estimateController = controller;
        // Navigation detaches the workspace. Stop paid requests immediately,
        // including when the user changes account or uses browser back.
        const observer = new MutationObserver(() => { if (!visible()) controller.abort(); });
        observer.observe(document.getElementById("app"), { childList: true, subtree: true });
        for (const item of items) selected.add(item.clientId);
        let saved = 0;
        let failures = 0;
        message = `Checking current prices for ${items.length} items, two at a time. You can pause whenever you like.`;
        paint();
        try {
          for (let offset = 0; offset < items.length && visible() && !controller.signal.aborted; offset += 2) {
            const updates = [];
            await Promise.all(items.slice(offset, offset + 2).map(async (item) => {
              rowErrors.delete(item.clientId);
              try {
                if (isUnknown(item)) throw new Error("Identify the title and format before checking prices.");
                const value = await api.valueEstimate(item, { ...requestOptions, signal: controller.signal });
                if (value.market?.status === "unavailable") throw new Error(value.summary || "The live price check is unavailable. Retry when the connection recovers.");
                if (sameUser()) updates.push({
                  clientId: item.clientId, estimate: value,
                  estimateFor: estimateSubject(item),
                });
              } catch (error) {
                if (controller.signal.aborted) return;
                failures++;
                rowErrors.set(item.clientId, error.message);
                // Avoid sending the rest of a large queue into an outage or
                // rate limit. Leave its selections intact for an explicit retry.
                if ([0, 401, 403, 408, 429, 503, 504].includes(error.status)) controller.abort();
              }
            }));
            if (!visible()) break;
            // Save each finished pair before starting another. Pausing cancels
            // provider calls, but doesn't discard a result already received.
            if (updates.length) {
              try {
                ({ list } = await api.updateScout(list.id, { items: updates }, requestOptions));
              } catch (error) {
                if (error.status === 409 && visible()) {
                  ({ list } = await api.getScout(list.id, requestOptions));
                  throw new Error("A find changed in another tab. The list is refreshed; retry the remaining selections.");
                }
                throw error;
              }
              if (!sameUser()) return;
              for (const item of updates) selected.delete(item.clientId);
              saved += updates.length;
            }
            message = `${saved} of ${items.length} estimates saved${failures ? ` · ${failures} need retry` : ""}…`;
            paint();
          }
          if (visible()) message = `${controller.signal.aborted ? "Paused. " : ""}${saved} of ${items.length} estimates saved.${selected.size ? " Remaining selections are ready to retry." : " Compare exact editions with sold listings before buying."}`;
        } finally {
          observer.disconnect();
          estimateController = null;
        }
      });
    }
    async function purchase(items) {
      if (!items.length) return;
      await run(async () => {
        let count = 0;
        for (let offset = 0; offset < items.length && visible(); offset += 100) {
          const chunk = items.slice(offset, offset + 100);
          if (chunk.some(isUnknown)) throw new Error("Unidentified items need a confirmed title and format before adding to your collection.");
          const existing = chunk.flatMap((item) => ownId(item) ? [{ clientId: item.clientId, purchasedTapeId: ownId(item) }] : []);
          const pending = chunk.filter((item) => !ownId(item));
          const result = pending.length ? await api.createTapes(pending.map(scoutPurchasePayload), requestOptions) : { tapes: [], failedCount: 0 };
          if (!sameUser()) return;
          upsertTapes(result.tapes || []);
          const added = (result.tapes || []).map((tape) => ({ clientId: tape.clientId, purchasedTapeId: tape.id }));
          const updates = [...existing, ...added];
          if (updates.length) {
            ({ list } = await api.updateScout(list.id, { items: updates }, requestOptions));
            if (!sameUser()) return;
            for (const item of updates) selected.delete(item.clientId);
            count += updates.length;
          }
          message = `${count} purchased ${count === 1 ? "item" : "items"} added to your collection.`;
          paint();
          if (result.failedCount || added.length < pending.length) throw new Error(`${count} added. Some items could not be saved; retry to finish safely.`);
        }
      });
    }
    paint();
  }
}
