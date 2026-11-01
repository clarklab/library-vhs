// Add flows: photo scan (primary), add by title, bulk paste, and portable file imports.

import { api } from "./api.js";
import { icons } from "./icons.js";
import { esc, parseBulkLine } from "./util.js";
import { coverArt } from "./covers.js";
import { openSheet, toast, spinnerButtonStart, spinnerButtonStop, wirePriceFields } from "./ui.js";
import { state, go, back, upsertTapes } from "./app.js";
import { tapeInsertMoment, buzz } from "./delight.js";
import { startBarcodeScanner, formatBarcode, cameraErrorMessage } from "./barcode.js";

// ---------- add sheet ----------

export function openAddSheet() {
  buzz(8);
  const { close } = openSheet({
    title: "Add Tapes",
    content: `
      <div class="action-list">
        <button class="action-item" data-go="scan">
          <div class="action-icon" style="background:var(--tint)">${icons.camera}</div>
          <div class="action-text">
            <h4>Scan a batch of photos</h4>
            <p>Capture up to 10 photos, then review the titles</p>
          </div>
        </button>
        <button class="action-item" data-go="barcode">
          <div class="action-icon" style="background:var(--pink)">${icons.barcode}</div>
          <div class="action-text">
            <h4>Scan a barcode</h4>
            <p>Point your camera at the UPC on the box</p>
          </div>
        </button>
        <button class="action-item" data-go="addTitle">
          <div class="action-icon" style="background:var(--purple)">${icons.keyboard}</div>
          <div class="action-text">
            <h4>Add by Title</h4>
            <p>Type a title, we'll fill in the details</p>
          </div>
        </button>
        <button class="action-item" data-go="bulk">
          <div class="action-icon" style="background:var(--orange)">${icons.listText}</div>
          <div class="action-text">
            <h4>Paste a List</h4>
            <p>One title per line, added all at once</p>
          </div>
        </button>
        <button class="action-item" data-go="backup">
          <div class="action-icon" style="background:var(--green)">${icons.fileCsv}</div>
          <div class="action-text">
            <h4>Import a file</h4>
            <p>Restore a backup, CSV or Excel collection</p>
          </div>
        </button>
      </div>`,
  });
  document.querySelectorAll("[data-go]").forEach((btn) =>
    btn.addEventListener("click", () => {
      close();
      setTimeout(() => go(btn.dataset.go), 150);
    })
  );
}

// A flow's async continuation must not clobber the screen if the user
// navigated away (e.g. hardware back) while the request was in flight.
const stillOn = (view) => state.view === view;

// ---------- shared: review & save ----------

/**
 * Renders the "review & price" step shared by every add flow.
 * items: [{title, year, director, genre, runtime, rated, plot, actors, imdbRating,
 *          imdbId, posterUrl, edition, matched, include, pricePaid, priceAsking}]
 */
function renderReview(root, items, { source, backView }) {
  const included = () => items.filter((i) => i.include !== false);

  root.innerHTML = `
    <div class="screen no-tabs">
      <div class="navbar">
        <div class="navbar-inner">
          <button class="nav-btn" data-back>${icons.chevronLeft}<span>Back</span></button>
          <div class="nav-title">Review &amp; Price</div>
          <span></span>
        </div>
      </div>
      <div class="section-pad">
        <div class="group">
          <label class="row"><span class="row-label">Asking price for all</span>
            <span class="price-field" data-price-field>
              <span class="price-prefix">$</span>
              <input data-bulk-asking inputmode="decimal" placeholder="0" autocomplete="off" />
              <span class="price-scrub" data-price-scrub>${icons.scrub}</span>
            </span>
          </label>
          <label class="row"><span class="row-label">Paid for all</span>
            <span class="price-field" data-price-field>
              <span class="price-prefix">$</span>
              <input data-bulk-paid inputmode="decimal" placeholder="0" autocomplete="off" />
              <span class="price-scrub" data-price-scrub>${icons.scrub}</span>
            </span>
          </label>
          <label class="row"><span class="row-label">Storage location</span>
            <input data-bulk-location placeholder="e.g. Box 7" />
          </label>
        </div>
        <p class="hint">Set prices for everything at once, or per tape below.</p>
        <div class="mt-16" data-cards></div>
        <div class="stack mt-24">
          <button class="btn" data-save-all>Add ${included().length} to Library</button>
        </div>
      </div>
    </div>`;

  const cards = root.querySelector("[data-cards]");
  const drawCards = () => {
    cards.innerHTML = items
      .map((item, i) => {
        // coverArt handles posters, the broken-poster fallback, and glint.
        const cover = coverArt(item);
        return `
        <div class="review-card ${item.include === false ? "excluded" : ""}" data-card="${i}" style="${item.include === false ? "opacity:.45" : ""}">
          <div class="review-thumb">${cover}</div>
          <div class="review-main">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
              <div style="min-width:0">
                <div class="review-title">${esc(item.title)}</div>
                <div class="review-sub">${[item.year, item.director].filter(Boolean).map(esc).join(" · ") || (item.matched === false ? "No details found — you can edit later" : "")}</div>
              </div>
              <button class="nav-btn" data-toggle="${i}" aria-label="Include">${item.include === false ? icons.plus : icons.close}</button>
            </div>
            <div class="review-prices">
              <div class="mini-field">
                <label>Asking</label>
                <span class="price-field" data-price-field>
                  <span class="price-prefix">$</span>
                  <input inputmode="decimal" placeholder="0" data-asking="${i}" value="${item.priceAsking ?? ""}" autocomplete="off" />
                  <span class="price-scrub" data-price-scrub>${icons.scrub}</span>
                </span>
              </div>
              <div class="mini-field">
                <label>Paid</label>
                <span class="price-field" data-price-field>
                  <span class="price-prefix">$</span>
                  <input inputmode="decimal" placeholder="0" data-paid="${i}" value="${item.pricePaid ?? ""}" autocomplete="off" />
                  <span class="price-scrub" data-price-scrub>${icons.scrub}</span>
                </span>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");
    cards.querySelectorAll("[data-toggle]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const item = items[Number(btn.dataset.toggle)];
        item.include = item.include === false;
        drawCards();
        updateSaveLabel();
      })
    );
    cards.querySelectorAll("[data-asking]").forEach((input) =>
      input.addEventListener("input", () => {
        items[Number(input.dataset.asking)].priceAsking = numOrNull(input.value);
      })
    );
    cards.querySelectorAll("[data-paid]").forEach((input) =>
      input.addEventListener("input", () => {
        items[Number(input.dataset.paid)].pricePaid = numOrNull(input.value);
      })
    );
    wirePriceFields(cards);
  };

  const updateSaveLabel = () => {
    root.querySelector("[data-save-all]").textContent = `Add ${included().length} to Library`;
  };

  drawCards();
  wirePriceFields(root.querySelector(".section-pad"));

  root.querySelector("[data-back]").addEventListener("click", () => {
    if (backView) go(backView, null, { replace: true });
    else back();
  });

  // Update card inputs in place (no rebuild) so scrubbing the bulk field is smooth.
  root.querySelector("[data-bulk-asking]").addEventListener("input", (e) => {
    const v = numOrNull(e.target.value);
    items.forEach((item) => (item.priceAsking = v));
    cards.querySelectorAll("[data-asking]").forEach((inp) => (inp.value = v ?? ""));
  });
  root.querySelector("[data-bulk-paid]").addEventListener("input", (e) => {
    const v = numOrNull(e.target.value);
    items.forEach((item) => (item.pricePaid = v));
    cards.querySelectorAll("[data-paid]").forEach((inp) => (inp.value = v ?? ""));
  });

  root.querySelector("[data-save-all]").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const chosen = included();
    if (chosen.length === 0) {
      toast("Nothing selected to add.", { error: true });
      return;
    }
    const location = root.querySelector("[data-bulk-location]").value.trim();
    spinnerButtonStart(btn);
    try {
      const payload = chosen.map((item) => ({
        title: item.title,
        year: item.year,
        director: item.director || "",
        actors: item.actors || [],
        genre: item.genre || "",
        runtime: item.runtime || "",
        rated: item.rated || "",
        plot: item.plot || "",
        imdbRating: item.imdbRating || "",
        imdbId: item.imdbId || "",
        posterUrl: item.posterUrl || "",
        edition: item.edition || "",
        format: item.format || "VHS",
        barcode: item.barcode || "",
        pricePaid: item.pricePaid ?? null,
        priceAsking: item.priceAsking ?? null,
        location,
        status: "keep", // not for sale until the owner flips it
        source,
      }));
      const created = [];
      let failed = 0;
      for (let i = 0; i < payload.length; i += 100) {
        const { tapes, failedCount } = await api.createTapes(payload.slice(i, i + 100));
        created.push(...tapes);
        failed += failedCount || 0;
      }
      upsertTapes(created);
      if (failed > 0) {
        toast(`Added ${created.length}, but ${failed} couldn't be saved.`, { error: true, duration: 4200 });
      } else {
        await tapeInsertMoment(`${created.length} tape${created.length === 1 ? "" : "s"} filed away`);
        toast(`Added ${created.length} tape${created.length === 1 ? "" : "s"}. 📼`);
      }
      go("library", null, { replace: true });
    } catch (err) {
      toast(err.message, { error: true });
      spinnerButtonStop(btn);
    }
  });
}

function numOrNull(value) {
  const raw = String(value).replace(/[$,\s]/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Enriches items ({title, year}) in chunks; merges results into copies. */
async function enrichItems(rawItems, onProgress) {
  const enriched = [];
  for (let i = 0; i < rawItems.length; i += 25) {
    const chunk = rawItems.slice(i, i + 25);
    onProgress?.(Math.min(i + chunk.length, rawItems.length), rawItems.length);
    const { results } = await api.enrich(chunk.map((item) => ({ title: item.title, year: item.year })));
    chunk.forEach((item, j) => {
      const hit = results?.[j] || {};
      enriched.push({
        ...item,
        title: hit.matched ? hit.title : item.title,
        year: hit.matched ? (hit.year ?? item.year) : item.year,
        director: hit.director || "",
        actors: hit.actors || [],
        genre: hit.genre || "",
        runtime: hit.runtime || "",
        rated: hit.rated || "",
        plot: hit.plot || "",
        imdbRating: hit.imdbRating || "",
        imdbId: hit.imdbId || "",
        posterUrl: hit.posterUrl || "",
        matched: Boolean(hit.matched),
        include: item.include !== false,
      });
    });
  }
  return enriched;
}

// Batch scanner is isolated so its durable session survives route changes.
export { renderScan } from "./scan.js";

function scanNav(title) {
  return `<div class="navbar"><div class="navbar-inner">
    <button class="nav-btn" data-back>${icons.chevronLeft}<span>Back</span></button>
    <div class="nav-title">${esc(title)}</div><span></span>
  </div></div>`;
}

// ---------- add by title ----------

export function renderAddTitle(root) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Add by Title")}
      <div class="section-pad stack">
        <input class="text-field" data-title placeholder="Movie title" autocapitalize="words" autofocus />
        <input class="text-field" data-year placeholder="Year (optional)" inputmode="numeric" />
        <button class="btn" data-lookup>${icons.sparkles} Look Up Details</button>
        <button class="btn gray" data-skip>Add Without Details</button>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => go("library", null, { replace: true }));

  const getInput = () => {
    const title = root.querySelector("[data-title]").value.trim();
    const yearRaw = root.querySelector("[data-year]").value.trim();
    const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
    return { title, year };
  };

  root.querySelector("[data-lookup]").addEventListener("click", async (event) => {
    const { title, year } = getInput();
    if (!title) {
      toast("Type a movie title first.", { error: true });
      return;
    }
    const btn = event.currentTarget;
    spinnerButtonStart(btn, " Looking up…");
    try {
      const enriched = await enrichItems([{ title, year }]);
      if (!stillOn("addTitle")) return;
      renderReview(root, enriched, { source: "manual", backView: "addTitle" });
    } catch (err) {
      if (!stillOn("addTitle")) return;
      toast(err.message, { error: true });
      spinnerButtonStop(btn);
    }
  });

  root.querySelector("[data-skip]").addEventListener("click", () => {
    const { title, year } = getInput();
    if (!title) {
      toast("Type a movie title first.", { error: true });
      return;
    }
    renderReview(root, [{ title, year, matched: false, include: true }], {
      source: "manual",
      backView: "addTitle",
    });
  });
}

// ---------- scan a barcode ----------

export function renderAddBarcode(root) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Scan a Barcode")}
      <div class="section-pad barcode-flow">
        <div class="barcode-camera" data-camera-frame>
          <video data-video playsinline muted aria-label="Camera preview"></video>
          <div class="barcode-guide" aria-hidden="true"><span></span></div>
          <div class="barcode-camera-message" data-camera-message>
            <p data-camera-status role="status">Starting camera…</p>
            <button type="button" class="btn" data-start-camera hidden>${icons.camera} Turn on camera</button>
          </div>
        </div>
        <p class="hint barcode-tip">Point your camera at the barcode on the back of the tape. Hold steady and let it fill the box.</p>
        <form class="barcode-manual" data-manual novalidate>
          <label for="barcode-code">Or type the numbers under the barcode</label>
          <div class="barcode-manual-row">
            <input id="barcode-code" class="text-field" name="code" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="0 86162 11134 1" />
            <button class="btn gray" type="submit">Look up</button>
          </div>
        </form>
        <div class="barcode-result" data-result hidden aria-live="polite"></div>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => go("library", null, { replace: true }));

  const frame = root.querySelector("[data-camera-frame]");
  const video = root.querySelector("[data-video]");
  const status = root.querySelector("[data-camera-status]");
  const startButton = root.querySelector("[data-start-camera]");
  const result = root.querySelector("[data-result]");
  const manual = root.querySelector("[data-manual]");
  let scanner = null;
  let looking = false;

  const startCamera = async () => {
    startButton.hidden = true;
    status.textContent = "Starting camera…";
    frame.classList.remove("live", "off");
    try {
      scanner = await startBarcodeScanner(video, { onCode: ({ code, format }) => lookup(code, format, { fromCamera: true }) });
      if (looking || !stillOn("barcode") || !video.isConnected) { scanner.stop(); return; }
      frame.classList.add("live");
      status.textContent = "Looking for a barcode…";
    } catch (error) {
      if (looking || !video.isConnected) return;
      frame.classList.add("off");
      status.textContent = cameraErrorMessage(error);
      startButton.hidden = false;
      startButton.innerHTML = `${icons.camera} Try the camera again`;
    }
  };

  async function lookup(code, format = "", { fromCamera = false } = {}) {
    looking = true;
    scanner?.stop();
    buzz(12);
    frame.classList.remove("live");
    frame.classList.add("off");
    status.textContent = fromCamera ? "Barcode read." : "Camera paused.";
    startButton.hidden = true;
    result.hidden = false;
    result.innerHTML = `<p class="barcode-looking"><span class="spinner"></span> Looking up ${esc(formatBarcode(code))}…</p>`;
    try {
      const found = await api.lookupUpc(code, format);
      if (!stillOn("barcode")) return;
      showMatch(found);
    } catch (error) {
      if (!stillOn("barcode")) return;
      result.innerHTML = `<p class="auth-error">${esc(error.message)}</p>`;
      looking = false;
      startButton.hidden = false;
      startButton.innerHTML = `${icons.camera} Scan again`;
    }
  }

  function showMatch(found) {
    const matched = found.status === "found";
    const pretty = formatBarcode(found.barcode);
    result.innerHTML = `
      <div class="barcode-match ${matched ? "found" : "missing"}">
        <p class="eyebrow">UPC ${esc(pretty)}</p>
        <h3>${matched ? "Found it" : "We couldn’t find this barcode"}</h3>
        <p class="barcode-match-copy">${matched ? "Check the title, then we’ll fill in the details." : "Type the title and we’ll keep the barcode with it."}</p>
        <form class="stack" data-confirm>
          <input class="text-field" name="title" aria-label="Movie title" placeholder="Movie title" autocapitalize="words" value="${esc(matched ? found.title : "")}" required />
          <input class="text-field" name="year" aria-label="Year (optional)" placeholder="Year (optional)" inputmode="numeric" value="${found.year ?? ""}" />
          <button class="btn" type="submit">${icons.sparkles} Look Up Details</button>
          <button class="btn gray" type="button" data-scan-again>${icons.barcode} Scan a different barcode</button>
        </form>
      </div>`;
    const form = result.querySelector("[data-confirm]");
    if (!matched) form.elements.title.focus();
    result.querySelector("[data-scan-again]").onclick = () => {
      result.hidden = true;
      result.innerHTML = "";
      looking = false;
      startCamera();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const title = form.elements.title.value.trim();
      const yearRaw = form.elements.year.value.trim();
      if (!title) {
        toast("Type a movie title first.", { error: true });
        return;
      }
      const item = {
        title, year: /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
        barcode: found.barcode, format: matched && found.format !== "Other" ? found.format : "VHS", edition: matched ? found.edition || "" : "",
      };
      const submit = form.querySelector("button[type=submit]");
      spinnerButtonStart(submit, " Looking up…");
      try {
        const enriched = await enrichItems([item]);
        if (!stillOn("barcode")) return;
        renderReview(root, enriched, { source: "barcode", backView: "barcode" });
      } catch (error) {
        if (!stillOn("barcode")) return;
        toast(error.message, { error: true });
        spinnerButtonStop(submit);
      }
    };
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  startButton.onclick = startCamera;
  manual.onsubmit = (event) => {
    event.preventDefault();
    const digits = manual.elements.code.value.replace(/\D/g, "");
    if (![8, 12, 13, 14].includes(digits.length)) {
      toast("Type all 12 or 13 numbers under the barcode.", { error: true });
      return;
    }
    lookup(digits);
  };
  startCamera();
}

// ---------- bulk paste ----------

export function renderBulk(root) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Paste a List")}
      <div class="section-pad stack">
        <textarea class="big-input" data-lines placeholder="One tape per line:\n\nThe Thing (1982)\nRoad House\nPredator 2, 1990"></textarea>
        <button class="btn" data-parse>${icons.sparkles} Look Up All Titles</button>
        <p class="hint" style="padding:0">Years in parentheses help match the right film. Up to 100 lines at a time.</p>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => go("library", null, { replace: true }));

  root.querySelector("[data-parse]").addEventListener("click", async (event) => {
    const lines = root
      .querySelector("[data-lines]")
      .value.split("\n")
      .map(parseBulkLine)
      .filter(Boolean)
      .slice(0, 100);
    if (lines.length === 0) {
      toast("Paste at least one title.", { error: true });
      return;
    }
    const btn = event.currentTarget;
    spinnerButtonStart(btn, ` Looking up ${lines.length}…`);
    try {
      const enriched = await enrichItems(lines, (done, total) => {
        btn.innerHTML = `<span class="spinner"></span> ${done}/${total}…`;
      });
      if (!stillOn("bulk")) return;
      renderReview(root, enriched, { source: "bulk", backView: "bulk" });
    } catch (err) {
      if (!stillOn("bulk")) return;
      toast(err.message, { error: true });
      spinnerButtonStop(btn);
    }
  });
}
