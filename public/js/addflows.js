// Add flows: photo scan (primary), add by title, bulk paste, CSV import.

import { api } from "./api.js";
import { icons } from "./icons.js";
import { esc, resizeImage, parseBulkLine, parseCsv } from "./util.js";
import { coverArt } from "./covers.js";
import { openSheet, toast, spinnerButtonStart, spinnerButtonStop, wirePriceFields } from "./ui.js";
import { state, go, back, upsertTapes } from "./app.js";
import { tapeInsertMoment, buzz } from "./delight.js";

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
            <h4>Scan a Photo</h4>
            <p>Snap 1 tape or a whole table — AI identifies them</p>
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
        <button class="action-item" data-go="csv">
          <div class="action-icon" style="background:var(--green)">${icons.fileCsv}</div>
          <div class="action-text">
            <h4>Import CSV</h4>
            <p>Bring in a spreadsheet of your inventory</p>
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

// ---------- scan flow ----------

const scan = { step: "pick", imageDataUrl: null, results: null, notes: "" };

export function renderScan(root) {
  if (scan.step === "review") {
    // handled inside flow; renderScan always restarts at current step
  }
  if (scan.step === "pick" || !scan.imageDataUrl) renderScanPick(root);
  else if (scan.step === "preview") renderScanPreview(root);
  else if (scan.step === "results") renderScanResults(root);
  else renderScanPick(root);
}

function scanNav(title) {
  return `
    <div class="navbar">
      <div class="navbar-inner">
        <button class="nav-btn" data-back>${icons.chevronLeft}<span>Back</span></button>
        <div class="nav-title">${esc(title)}</div>
        <span></span>
      </div>
    </div>`;
}

function renderScanPick(root) {
  scan.step = "pick";
  scan.imageDataUrl = null;
  scan.results = null;

  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Scan Tapes")}
      <div class="section-pad stack">
        <button class="photo-drop" data-take>
          ${icons.camera}
          <div><strong>Take a Photo</strong></div>
          <div class="text-small">One tape or twenty — covers, spines, or a full table</div>
        </button>
        <button class="btn tinted" data-choose>${icons.photo} Choose from Library</button>
        <input type="file" accept="image/*" capture="environment" hidden data-file-camera />
        <input type="file" accept="image/*" hidden data-file-library />
        <p class="hint" style="padding:0">Tips: fill the frame with the tapes, keep spines readable, avoid glare. The AI counts every tape it sees and reads each title.</p>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => go("library", null, { replace: true }));

  const cameraInput = root.querySelector("[data-file-camera]");
  const libraryInput = root.querySelector("[data-file-library]");
  root.querySelector("[data-take]").addEventListener("click", () => cameraInput.click());
  root.querySelector("[data-choose]").addEventListener("click", () => libraryInput.click());

  const handleFile = async (input) => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      scan.imageDataUrl = await resizeImage(file);
      scan.step = "preview";
      renderScan(root);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  cameraInput.addEventListener("change", () => handleFile(cameraInput));
  libraryInput.addEventListener("change", () => handleFile(libraryInput));
}

function renderScanPreview(root) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Scan Tapes")}
      <div class="section-pad stack">
        <div class="photo-preview"><img src="${scan.imageDataUrl}" alt="Your photo" /></div>
        <button class="btn" data-scan>${icons.sparkles} Identify Tapes</button>
        <button class="btn gray" data-retake>Retake Photo</button>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => {
    scan.step = "pick";
    renderScan(root);
  });
  root.querySelector("[data-retake]").addEventListener("click", () => {
    scan.step = "pick";
    renderScan(root);
  });
  root.querySelector("[data-scan]").addEventListener("click", async () => {
    renderScanLoading(root, "Reading labels");
    try {
      const result = await api.scanPhoto(scan.imageDataUrl);
      scan.results = result.tapes.map((t) => ({ ...t, include: true }));
      scan.notes = result.notes || "";
      scan.step = "results";
      if (stillOn("scan")) renderScan(root);
    } catch (err) {
      scan.step = "preview";
      if (stillOn("scan")) {
        toast(err.message, { error: true, duration: 4200 });
        renderScan(root);
      }
    }
  });
}

function renderScanLoading(root, label) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Scanning…")}
      <div class="section-pad">
        <div class="photo-preview scanning">
          <img src="${scan.imageDataUrl}" alt="" />
          <span class="vf-corner tl"></span><span class="vf-corner tr"></span>
          <span class="vf-corner bl"></span><span class="vf-corner br"></span>
          <div class="scan-beam"></div>
        </div>
        <div class="vcr-loading">
          <div class="vcr-screen">
            <div>▶ ${esc(label)}<span class="vcr-blink">▌</span></div>
            <div class="vcr-tracking"></div>
            <div class="mt-8" style="font-size:11px; opacity:.7">AI VISION · PLEASE STAND BY</div>
          </div>
        </div>
      </div>
    </div>`;
  root.querySelector("[data-back]")?.addEventListener("click", () => {
    scan.step = "preview";
    renderScan(root);
  });
}

function renderScanResults(root) {
  const results = scan.results || [];
  const includedCount = () => results.filter((r) => r.include).length;

  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Found Tapes")}
      <div class="section-pad">
        <div class="stat-card wide">
          <div class="stat-label">Tapes spotted in your photo</div>
          <div class="stat-value">${results.length}</div>
          ${scan.notes ? `<div class="stat-sub">⚠️ ${esc(scan.notes)}</div>` : ""}
        </div>
        <p class="hint" style="padding-left:0">Uncheck anything that's wrong, fix titles if needed, then look up the details.</p>
        <div class="mt-8" data-rows></div>
        <div class="stack mt-24">
          <button class="btn" data-lookup>${icons.sparkles} Look Up Details (${includedCount()})</button>
          <button class="btn gray" data-rescan>Scan a Different Photo</button>
        </div>
      </div>
    </div>`;

  const rowsEl = root.querySelector("[data-rows]");
  const draw = () => {
    rowsEl.innerHTML = results
      .map(
        (r, i) => `
      <div class="scan-result-row ${r.include ? "" : "excluded"}">
        <button class="scan-check ${r.include ? "checked" : ""}" data-check="${i}" aria-label="Include">${icons.check}</button>
        <div class="scan-result-main">
          <input value="${esc(r.title)}" data-title="${i}" />
          <div class="scan-result-sub">${[r.year, r.visual].filter(Boolean).map(esc).join(" · ")}${r.edition ? ` · ${esc(r.edition)}` : ""}</div>
        </div>
        <span class="conf-badge conf-${r.confidence}">${r.confidence}</span>
      </div>`
      )
      .join("");
    rowsEl.querySelectorAll("[data-check]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const r = results[Number(btn.dataset.check)];
        r.include = !r.include;
        buzz(6);
        draw();
        root.querySelector("[data-lookup]").innerHTML = `${icons.sparkles} Look Up Details (${includedCount()})`;
      })
    );
    rowsEl.querySelectorAll("[data-title]").forEach((input) =>
      input.addEventListener("input", () => {
        results[Number(input.dataset.title)].title = input.value;
      })
    );
  };
  draw();

  root.querySelector("[data-back]").addEventListener("click", () => {
    scan.step = "preview";
    renderScan(root);
  });
  root.querySelector("[data-rescan]").addEventListener("click", () => {
    scan.step = "pick";
    renderScan(root);
  });

  root.querySelector("[data-lookup]").addEventListener("click", async () => {
    const chosen = results.filter((r) => r.include && r.title.trim());
    if (chosen.length === 0) {
      toast("Select at least one tape.", { error: true });
      return;
    }
    renderScanLoading(root, "Looking up film data");
    try {
      const enriched = await enrichItems(
        chosen.map((r) => ({ title: r.title.trim(), year: r.year, edition: r.edition })),
        () => {}
      );
      if (!stillOn("scan")) return;
      scan.step = "pick"; // reset for next time
      renderReview(root, enriched, { source: "photo", backView: "scan" });
    } catch (err) {
      scan.step = "results";
      if (stillOn("scan")) {
        toast(err.message, { error: true, duration: 4200 });
        renderScan(root);
      }
    }
  });
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

// ---------- CSV import ----------

const CSV_FIELDS = [
  { id: "", label: "— skip —" },
  { id: "title", label: "Title" },
  { id: "year", label: "Year" },
  { id: "director", label: "Director" },
  { id: "genre", label: "Genre" },
  { id: "condition", label: "Condition" },
  { id: "status", label: "Status" },
  { id: "pricePaid", label: "Price Paid" },
  { id: "priceAsking", label: "Asking Price" },
  { id: "priceSold", label: "Sold Price" },
  { id: "location", label: "Location" },
  { id: "edition", label: "Edition" },
  { id: "label", label: "Studio / Label" },
  { id: "packaging", label: "Packaging" },
  { id: "sealed", label: "Sealed (yes/no)" },
  { id: "acquiredFrom", label: "Where Acquired" },
  { id: "acquiredDate", label: "Date Acquired" },
  { id: "barcode", label: "Barcode" },
  { id: "notes", label: "Notes" },
];

const CSV_AUTO = {
  title: /^(title|movie|film|name)$/i,
  year: /^(year|released?|release year)$/i,
  director: /^director/i,
  genre: /^genre/i,
  condition: /^cond/i,
  status: /^status$/i,
  priceSold: /sold|sale price/i,
  pricePaid: /paid|cost|purchase/i,
  priceAsking: /asking|^price$|sell price|list price/i,
  location: /^(location|box|shelf|storage)/i,
  edition: /^(edition|release|version)/i,
  label: /^(label|studio|distributor)/i,
  packaging: /^packag/i,
  sealed: /^sealed$/i,
  acquiredFrom: /acquired from|where acquired|source$/i,
  acquiredDate: /acquired date|date acquired/i,
  barcode: /barcode|upc/i,
  notes: /^(notes?|comments?|description)$/i,
};

export function renderCsv(root) {
  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Import CSV")}
      <div class="section-pad stack">
        <button class="file-drop" data-drop>
          ${icons.fileCsv}
          <div><strong>Choose a CSV file</strong></div>
          <div class="text-small mt-8">First row should be column headers.<br/>A “Title” column is required — everything else is optional.</div>
        </button>
        <input type="file" accept=".csv,text/csv" hidden data-file />
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => go("library", null, { replace: true }));

  const fileInput = root.querySelector("[data-file]");
  root.querySelector("[data-drop]").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      toast("That CSV needs a header row plus at least one tape.", { error: true });
      return;
    }
    renderCsvMapping(root, rows);
  });
}

function renderCsvMapping(root, rows) {
  const headers = rows[0];
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));
  const mapping = headers.map((h) => {
    for (const [field, re] of Object.entries(CSV_AUTO)) {
      if (re.test(h.trim())) return field;
    }
    return "";
  });

  root.innerHTML = `
    <div class="screen no-tabs">
      ${scanNav("Map Columns")}
      <div class="section-pad">
        <p class="hint" style="padding-left:0">${dataRows.length} rows found. Match your columns to VHS Vault fields:</p>
        <div class="group mt-8" style="padding:6px 0">
          <table class="map-table">
            <thead><tr><th>Your column</th><th>Example</th><th>Import as</th></tr></thead>
            <tbody>
              ${headers
                .map(
                  (h, i) => `
                <tr>
                  <td><strong>${esc(h || `Column ${i + 1}`)}</strong></td>
                  <td class="text-secondary">${esc((dataRows[0]?.[i] || "").slice(0, 24))}</td>
                  <td>
                    <select data-map="${i}">
                      ${CSV_FIELDS.map((f) => `<option value="${f.id}" ${mapping[i] === f.id ? "selected" : ""}>${f.label}</option>`).join("")}
                    </select>
                  </td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
        <div class="group mt-16">
          <label class="row">
            <span class="row-label">Look up missing details</span>
            <input type="checkbox" data-enrich checked style="flex:none; width:22px; height:22px; accent-color:var(--tint)" />
          </label>
        </div>
        <p class="hint" style="padding-left:0">Fills in director, year, genre and cover art for rows that don't have them (uses AI, works in batches).</p>
        <div class="stack mt-24">
          <button class="btn" data-import>Import ${dataRows.length} Rows</button>
        </div>
      </div>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => renderCsv(root));
  root.querySelectorAll("[data-map]").forEach((sel) =>
    sel.addEventListener("change", () => {
      mapping[Number(sel.dataset.map)] = sel.value;
    })
  );

  root.querySelector("[data-import]").addEventListener("click", async (event) => {
    if (!mapping.includes("title")) {
      toast("Map one column to Title.", { error: true });
      return;
    }
    const wantEnrich = root.querySelector("[data-enrich]").checked;
    const btn = event.currentTarget;
    spinnerButtonStart(btn, " Importing…");

    const items = dataRows
      .map((row) => {
        const item = {};
        mapping.forEach((field, i) => {
          if (!field) return;
          const value = (row[i] || "").trim();
          if (!value) return;
          if (["pricePaid", "priceAsking", "priceSold", "year"].includes(field)) {
            const n = Number(value.replace(/[$,\s]/g, ""));
            if (Number.isFinite(n)) item[field] = n;
          } else if (field === "status") {
            const v = value.toLowerCase();
            const statusMap = { sold: "sold", hold: "hold", "on hold": "hold", keep: "keep", keeper: "keep", available: "available", "for sale": "available" };
            item.status = statusMap[v] || "keep";
          } else if (field === "condition") {
            const v = value.toLowerCase();
            if (["sealed", "mint", "good", "fair", "poor"].includes(v)) item.condition = v;
          } else if (field === "sealed") {
            item.sealed = ["yes", "true", "1", "sealed", "y"].includes(value.toLowerCase());
          } else if (field === "packaging") {
            const v = value.toLowerCase().replace(/[\s-]/g, "");
            const match = { slipcase: "slipcase", bigbox: "bigbox", clamshell: "clamshell", screener: "screener" }[v];
            item.packaging = match || "other";
          } else {
            item[field] = value;
          }
        });
        return item.title ? item : null;
      })
      .filter(Boolean);

    if (items.length === 0) {
      toast("No rows had a title.", { error: true });
      spinnerButtonStop(btn);
      return;
    }

    try {
      if (wantEnrich) {
        // Enrich every row: your CSV values win, lookups fill the gaps —
        // and cover art / IMDb data always comes along when available.
        let done = 0;
        for (let i = 0; i < items.length; i += 25) {
          const chunk = items.slice(i, i + 25);
          btn.innerHTML = `<span class="spinner"></span> Looking up ${Math.min(done + chunk.length, items.length)}/${items.length}…`;
          const { results } = await api.enrich(chunk.map((c) => ({ title: c.title, year: c.year })));
          chunk.forEach((item, j) => {
            const hit = results?.[j];
            if (!hit?.matched) return;
            item.year = item.year ?? hit.year;
            item.director = item.director || hit.director;
            item.genre = item.genre || hit.genre;
            item.actors = item.actors?.length ? item.actors : hit.actors;
            item.runtime = item.runtime || hit.runtime;
            item.rated = item.rated || hit.rated;
            item.plot = item.plot || hit.plot;
            item.imdbRating = item.imdbRating || hit.imdbRating;
            item.imdbId = item.imdbId || hit.imdbId;
            item.posterUrl = item.posterUrl || hit.posterUrl;
          });
          done += chunk.length;
        }
      }

      btn.innerHTML = `<span class="spinner"></span> Saving…`;
      const created = [];
      let failed = 0;
      for (let i = 0; i < items.length; i += 100) {
        const { tapes, failedCount } = await api.createTapes(
          items.slice(i, i + 100).map((item) => ({ ...item, source: "csv" }))
        );
        created.push(...tapes);
        failed += failedCount || 0;
      }
      upsertTapes(created);
      if (failed > 0) {
        toast(`Imported ${created.length}, but ${failed} couldn't be saved.`, { error: true, duration: 4200 });
      } else {
        await tapeInsertMoment(`${created.length} tape${created.length === 1 ? "" : "s"} filed away`);
        toast(`Imported ${created.length} tapes. 📼`);
      }
      go("library", null, { replace: true });
    } catch (err) {
      toast(err.message, { error: true, duration: 4200 });
      spinnerButtonStop(btn);
    }
  });
}
