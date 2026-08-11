// Library (grid/list) and tape detail/editor views.

import { api } from "./api.js";
import { icons } from "./icons.js";
import { esc, money, debounce, statusLabel, conditionLabel, resizeImage } from "./util.js";
import { coverArt, isSealed } from "./covers.js";
import { toast, confirmSheet, emptyState, openSheet, spinnerButtonStart, spinnerButtonStop, priceField, wirePriceFields } from "./ui.js";
import { state, go, back, rerender, upsertTapes, removeTape } from "./app.js";
import { tapeMascot, soldCelebration } from "./delight.js";
import { exportCsv, exportXls } from "./exporter.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "available", label: "For Sale" },
  { id: "sold", label: "Sold" },
  { id: "hold", label: "On Hold" },
  { id: "keep", label: "Keepers" },
];

const SORTS = [
  { id: "added", label: "Recently Added" },
  { id: "title", label: "Title A–Z" },
  { id: "year", label: "Year" },
  { id: "priceAsking", label: "Asking Price" },
  { id: "pricePaid", label: "Price Paid" },
];

export function filteredTapes() {
  const { query, filter, sort } = state.library;
  let tapes = [...state.tapes];
  if (filter !== "all") tapes = tapes.filter((t) => (t.status || "keep") === filter);
  if (query) {
    const q = query.toLowerCase();
    tapes = tapes.filter((t) =>
      [t.title, t.director, t.genre, t.location, t.notes, t.label, t.edition, ...(t.actors || []), ...(t.tags || [])]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }
  const cmp = {
    added: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
    title: (a, b) => (a.title || "").localeCompare(b.title || ""),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    priceAsking: (a, b) => (b.priceAsking ?? -1) - (a.priceAsking ?? -1),
    pricePaid: (a, b) => (b.pricePaid ?? -1) - (a.pricePaid ?? -1),
  }[sort];
  tapes.sort(cmp);
  return tapes;
}

export function renderLibrary(root) {
  const lib = state.library;
  const tapes = filteredTapes();

  root.innerHTML = `
    <div class="screen">
      <h1 class="large-title" style="padding-top:18px">Library</h1>
      <div class="section-pad" style="padding-top:4px">
        <div class="view-options">
          <div class="searchbar">
            ${icons.search}
            <input type="search" placeholder="Search tapes…" value="${esc(lib.query)}" data-search autocapitalize="off" />
          </div>
          <div class="segmented" style="flex:none">
            <button data-mode="grid" class="${lib.mode === "grid" ? "active" : ""}" aria-label="Cover view">${icons.grid}</button>
            <button data-mode="list" class="${lib.mode === "list" ? "active" : ""}" aria-label="List view">${icons.rows}</button>
            <button data-mode="sheet" class="${lib.mode === "sheet" ? "active" : ""}" aria-label="Spreadsheet view">${icons.table}</button>
          </div>
          <button class="sort-btn" data-sort aria-label="Sort">${icons.sortArrows}</button>
        </div>
      </div>
      <div class="chips" style="margin-top:6px">
        ${FILTERS.map((f) => {
          const n = countFor(f.id);
          return `<button class="chip${lib.filter === f.id ? " active" : ""}" data-filter="${f.id}">
              <span class="chip-label">${f.label}</span>${n ? `<span class="chip-sep"></span><span class="chip-count">${n}</span>` : ""}
            </button>`;
        }).join("")}
      </div>
      <div class="mt-8" data-list-container></div>
    </div>`;

  renderListContainer(root.querySelector("[data-list-container]"), tapes);

  const searchInput = root.querySelector("[data-search]");
  searchInput.addEventListener(
    "input",
    debounce(() => {
      state.library.query = searchInput.value;
      renderListContainer(root.querySelector("[data-list-container]"), filteredTapes());
    }, 180)
  );

  root.querySelectorAll("[data-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.library.mode = btn.dataset.mode;
      rerender();
    })
  );
  root.querySelectorAll("[data-filter]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.library.filter = btn.dataset.filter;
      rerender();
    })
  );
  root.querySelector("[data-sort]").addEventListener("click", () => {
    const { close } = openSheet({
      title: "Sort By",
      content: `<div class="group">${SORTS.map(
        (s) =>
          `<button class="row tappable" data-sortopt="${s.id}">
             <span class="row-label">${s.label}</span>
             <span class="row-value">${state.library.sort === s.id ? icons.check.replace("<svg", '<svg style="width:18px;height:18px;color:var(--tint)"') : ""}</span>
           </button>`
      ).join("")}</div>`,
    });
    document.querySelectorAll("[data-sortopt]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.library.sort = btn.dataset.sortopt;
        close();
        rerender();
      })
    );
  });
}

function countFor(filterId) {
  if (filterId === "all") return state.tapes.length;
  return state.tapes.filter((t) => (t.status || "keep") === filterId).length;
}

function renderListContainer(container, tapes) {
  if (!state.loaded) {
    container.innerHTML = `<div class="centered-note"><span class="spinner dark" style="margin:0 auto"></span></div>`;
    return;
  }
  if (state.tapes.length === 0) {
    container.innerHTML = `
      <div class="empty fade-in">
        <div style="margin-bottom:16px">${tapeMascot()}</div>
        <h3>No tapes yet</h3>
        <p>Tap the + button and scan a photo of your tapes to get started.</p>
        <div class="blink-play">▶ INSERT TAPE</div>
      </div>`;
    return;
  }
  if (tapes.length === 0) {
    container.innerHTML = emptyState({
      icon: icons.search,
      title: "No matches",
      message: "Try a different search or filter.",
    });
    return;
  }

  if (state.library.mode === "grid") {
    container.innerHTML = `
      <div class="cover-grid">
        ${tapes.map((tape, i) => coverCell(tape, i)).join("")}
      </div>
      <div class="count-footer">${tapes.length} tape${tapes.length === 1 ? "" : "s"}</div>`;
  } else if (state.library.mode === "sheet") {
    renderSheetView(container, tapes);
    return; // sheet wires its own handlers (row taps are on the title cell only)
  } else {
    container.innerHTML = `
      <div class="tape-list">
        ${tapes.map((tape, i) => listRow(tape, i)).join("")}
        <div class="count-footer">${tapes.length} tape${tapes.length === 1 ? "" : "s"}</div>
      </div>`;
  }
  container.querySelectorAll("[data-tape]").forEach((el) =>
    el.addEventListener("click", () => go("detail", el.dataset.tape))
  );
}

// ---------- spreadsheet view ----------

const SHEET_STATUS = [["keep", "Keeper"], ["available", "For Sale"], ["hold", "On Hold"], ["sold", "Sold"]];
const SHEET_CONDITIONS = [["", "—"], ["sealed", "Sealed"], ["mint", "Mint"], ["good", "Good"], ["fair", "Fair"], ["poor", "Poor"]];

function renderSheetView(container, tapes) {
  container.innerHTML = `
    <div class="sheet-view">
      <div class="sheet-tools">
        <span class="sheet-count">${tapes.length} tape${tapes.length === 1 ? "" : "s"} · edits save automatically</span>
        <span style="flex:1"></span>
        <button class="chip" data-sheet-csv>${icons.fileCsv} CSV</button>
        <button class="chip" data-sheet-xls>${icons.export} Excel</button>
      </div>
      <div class="sheet-scroll">
        <table class="sheet-table">
          <thead>
            <tr>
              <th class="col-title">Title</th><th>Year</th><th>Status</th><th>Condition</th>
              <th>Paid</th><th>Asking</th><th>Sold</th><th>Location</th><th>Edition</th>
            </tr>
          </thead>
          <tbody>
            ${tapes.map((t) => sheetRow(t)).join("")}
          </tbody>
        </table>
      </div>
    </div>`;

  container.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => go("detail", el.dataset.open))
  );
  container.querySelector("[data-sheet-csv]").addEventListener("click", () => {
    exportCsv(tapes);
    toast("CSV downloaded.");
  });
  container.querySelector("[data-sheet-xls]").addEventListener("click", () => {
    exportXls(tapes);
    toast("Excel file downloaded.");
  });

  // Inline edits: every cell change PATCHes just that field, then flashes.
  container.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("change", async () => {
      const row = el.closest("tr");
      const id = row.dataset.row;
      const field = el.dataset.field;
      let value = el.value;
      if (["year", "pricePaid", "priceAsking", "priceSold"].includes(field)) {
        const n = Number(String(value).replace(/[$,\s]/g, ""));
        value = value.trim() === "" ? null : Number.isFinite(n) ? n : null;
      }
      try {
        const patch = { [field]: value };
        if (field === "status" && value === "sold") {
          const tape = state.tapes.find((t) => t.id === id);
          if (tape && !tape.soldDate) patch.soldDate = new Date().toISOString().slice(0, 10);
        }
        const { tape: updated } = await api.updateTape(id, patch);
        upsertTapes([updated]);
        el.classList.remove("cell-saved");
        void el.offsetWidth; // restart the flash animation
        el.classList.add("cell-saved");
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  });
}

function sheetRow(t) {
  const priceInput = (field, value) =>
    `<td class="num"><input data-field="${field}" value="${value ?? ""}" inputmode="decimal" placeholder="—" /></td>`;
  return `
    <tr data-row="${esc(t.id)}">
      <td class="col-title"><button data-open="${esc(t.id)}" title="Open details">${esc(t.title)}${t.sealed || t.condition === "sealed" ? " 🔒" : ""}</button></td>
      <td class="num"><input data-field="year" value="${t.year ?? ""}" inputmode="numeric" placeholder="—" /></td>
      <td><select data-field="status">${SHEET_STATUS.map(([v, l]) => `<option value="${v}" ${(t.status || "keep") === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><select data-field="condition">${SHEET_CONDITIONS.map(([v, l]) => `<option value="${v}" ${(t.condition || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      ${priceInput("pricePaid", t.pricePaid)}
      ${priceInput("priceAsking", t.priceAsking)}
      ${priceInput("priceSold", t.priceSold)}
      <td><input data-field="location" value="${esc(t.location || "")}" placeholder="—" /></td>
      <td><input data-field="edition" value="${esc(t.edition || "")}" placeholder="—" /></td>
    </tr>`;
}

function coverCell(tape, index = 0) {
  const status = tape.status || "keep";
  const badge =
    status === "sold"
      ? `<span class="cover-badge badge-sold">Sold</span>`
      : status === "hold"
        ? `<span class="cover-badge badge-hold">Hold</span>`
        : status === "keep"
          ? `<span class="cover-badge badge-keep">Keep</span>`
          : "";
  return `
    <button class="cover-cell" data-tape="${esc(tape.id)}" style="--i:${Math.min(index, 14)}">
      <div class="cover-art box3d"><span class="box-spine"></span><span class="box-top"></span>${coverArt(tape)}${badge}</div>
      <div class="cover-title">${esc(tape.title)}</div>
      <div class="cover-sub">${tape.year || ""}${tape.priceAsking != null && status !== "sold" ? `${tape.year ? " · " : ""}${money(tape.priceAsking)}` : ""}</div>
    </button>`;
}

function listRow(tape, index = 0) {
  const status = tape.status || "keep";
  const price = status === "sold" ? tape.priceSold ?? tape.priceAsking : tape.priceAsking;
  return `
    <button class="tape-row" data-tape="${esc(tape.id)}" style="--i:${Math.min(index, 12)}">
      <div class="tape-thumb">${coverArt(tape)}</div>
      <div class="tape-row-main">
        <div class="tape-row-title">${esc(tape.title)}</div>
        <div class="tape-row-sub">${[tape.year, tape.director].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</div>
        <div class="tape-row-sub">${[conditionLabel(tape.condition) !== "—" ? conditionLabel(tape.condition) : "", tape.location].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</div>
      </div>
      <div class="tape-row-meta">
        <div class="tape-row-price">${price != null ? money(price) : ""}</div>
        <div class="tape-row-status status-${status}">${statusLabel(status)}</div>
      </div>
    </button>`;
}

// ---------- detail / editor ----------

export function renderDetail(root, tapeId) {
  const tape = state.tapes.find((t) => t.id === tapeId);
  if (!tape) {
    go("library", null, { replace: true });
    return;
  }
  const status = tape.status || "keep";

  root.innerHTML = `
    <div class="screen no-tabs detail-screen" style="view-transition-name: detail-screen">
      <div class="navbar">
        <div class="navbar-inner">
          <button class="nav-btn" data-back>${icons.chevronLeft}<span>Library</span></button>
          <div class="nav-title">${esc(tape.title)}</div>
          <button class="nav-btn bold" data-save>Save</button>
        </div>
      </div>

      <div class="detail-hero fade-in">
        <div class="detail-cover-wrap">
          <div class="detail-cover box3d" style="view-transition-name: tape-poster"><span class="box-spine"></span><span class="box-top"></span>${coverArt(tape)}</div>
          <button class="cover-edit" data-change-cover aria-label="Upload a new cover">${icons.camera}</button>
          <input type="file" accept="image/*" data-cover-file hidden />
        </div>
        <div class="detail-hero-main">
          <div class="detail-title">${esc(tape.title)}</div>
          <div class="detail-sub">${[tape.year, tape.rated, tape.runtime].filter(Boolean).map(esc).join(" · ")}</div>
          <div class="pill-row">
            ${isSealed(tape) ? `<span class="pill" style="background:rgba(52,199,89,0.18); color:var(--green)">SEALED</span>` : ""}
            ${(tape.genre || "").split(",").map((g) => g.trim()).filter(Boolean).map((g) => `<span class="pill">${esc(g)}</span>`).join("")}
            ${tape.imdbRating ? `<span class="pill">★ ${esc(tape.imdbRating)}</span>` : ""}
            ${tape.packaging ? `<span class="pill">${esc({ slipcase: "Slipcase", bigbox: "Big Box", clamshell: "Clamshell", screener: "Screener", other: "Other pkg." }[tape.packaging] || tape.packaging)}</span>` : ""}
          </div>
          ${tape.plot ? `<div class="detail-plot">${esc(tape.plot)}</div>` : ""}
        </div>
      </div>

      <form class="section-pad" data-form>
        <div class="group-label">Film Details</div>
        <div class="group">
          ${textRow("title", "Title", tape.title)}
          ${textRow("year", "Year", tape.year ?? "", "numeric")}
          ${textRow("director", "Director", tape.director)}
          ${textRow("actors", "Actors", (tape.actors || []).join(", "))}
          ${textRow("genre", "Genre", tape.genre)}
          ${textRow("label", "Studio / Label", tape.label, "text", "e.g. Media Home Ent.")}
          ${textRow("edition", "Edition / Release", tape.edition, "text", "e.g. director's cut, ex-rental")}
        </div>

        <div class="group-label">The Tape Itself</div>
        <div class="group">
          <label class="row"><span class="row-label">Factory Sealed</span>
            <span style="flex:1"></span>
            <span class="switch"><input type="checkbox" name="sealed" ${isSealed(tape) ? "checked" : ""} /><span class="knob"></span></span>
          </label>
          <label class="row"><span class="row-label">Condition</span>
            <select name="condition">
              <option value="">—</option>
              ${["sealed", "mint", "good", "fair", "poor"].map((c) => `<option value="${c}" ${tape.condition === c ? "selected" : ""}>${conditionLabel(c)}</option>`).join("")}
            </select>
          </label>
          <label class="row"><span class="row-label">Packaging</span>
            <select name="packaging">
              ${[["", "—"], ["slipcase", "Slipcase"], ["bigbox", "Big Box"], ["clamshell", "Clamshell"], ["screener", "Screener"], ["other", "Other"]].map(([v, l]) => `<option value="${v}" ${(tape.packaging || "") === v ? "selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
          ${textRow("barcode", "Barcode / UPC", tape.barcode, "numeric")}
        </div>

        <div class="group-label">Inventory</div>
        <div class="group">
          <label class="row"><span class="row-label">Status</span>
            <select name="status">
              ${["available", "hold", "keep", "sold"].map((s) => `<option value="${s}" ${status === s ? "selected" : ""}>${statusLabel(s)}</option>`).join("")}
            </select>
          </label>
          <label class="row"><span class="row-label">Price Paid</span>${priceField({ name: "pricePaid", value: tape.pricePaid ?? "" })}</label>
          <label class="row"><span class="row-label">Asking Price</span>${priceField({ name: "priceAsking", value: tape.priceAsking ?? "" })}</label>
          ${status === "sold" ? `<label class="row"><span class="row-label">Sold For</span>${priceField({ name: "priceSold", value: tape.priceSold ?? "" })}</label>` : ""}
          ${textRow("location", "Storage Location", tape.location, "text", "e.g. Box 3, garage shelf B")}
          ${textRow("acquiredFrom", "Where Acquired", tape.acquiredFrom, "text", "e.g. Rose Bowl swap meet")}
          <label class="row"><span class="row-label">Date Acquired</span>
            <input name="acquiredDate" type="date" value="${esc(tape.acquiredDate || "")}" style="text-align:right" />
          </label>
        </div>

        <div class="group-label">Notes</div>
        <div class="group">
          <label class="row stacked">
            <textarea name="notes" placeholder="Condition details, provenance, what to tell buyers…">${esc(tape.notes || "")}</textarea>
          </label>
        </div>

        <div class="stack mt-24">
          ${status !== "sold" ? `<button type="button" class="btn tinted" data-marksold>${icons.dollar} Mark as Sold</button>` : ""}
          <button type="button" class="btn tinted" data-value>${icons.stats} Check Market Value</button>
          <button type="button" class="btn tinted" data-relookup>${icons.sparkles} Refresh Movie Details</button>
          <button type="button" class="btn destructive" data-delete>Delete Tape</button>
        </div>
      </form>
    </div>`;

  root.querySelector("[data-back]").addEventListener("click", () => back());

  const form = root.querySelector("[data-form]");

  const readForm = () => {
    const val = (name) => form.querySelector(`[name=${name}]`)?.value ?? "";
    const numOrNull = (name) => {
      const raw = val(name).replace(/[$,\s]/g, "");
      if (raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    return {
      title: val("title").trim(),
      year: numOrNull("year"),
      director: val("director").trim(),
      actors: val("actors").split(",").map((a) => a.trim()).filter(Boolean),
      genre: val("genre").trim(),
      label: val("label").trim(),
      edition: val("edition").trim(),
      sealed: Boolean(form.querySelector("[name=sealed]")?.checked),
      packaging: val("packaging"),
      status: val("status"),
      condition: val("condition"),
      pricePaid: numOrNull("pricePaid"),
      priceAsking: numOrNull("priceAsking"),
      ...(form.querySelector("[name=priceSold]") ? { priceSold: numOrNull("priceSold") } : {}),
      location: val("location").trim(),
      acquiredFrom: val("acquiredFrom").trim(),
      acquiredDate: val("acquiredDate"),
      barcode: val("barcode").trim(),
      notes: val("notes").trim(),
    };
  };

  wirePriceFields(form);

  // Flipping the Sealed switch updates the cover's shrink-wrap glint live.
  form.querySelector("[name=sealed]")?.addEventListener("change", (event) => {
    const coverEl = root.querySelector(".detail-cover");
    const existing = coverEl.querySelector(".seal-glint");
    if (event.target.checked && !existing) {
      coverEl.insertAdjacentHTML("beforeend", `<span class="seal-glint" aria-hidden="true"></span>`);
    } else if (!event.target.checked && existing && tape.condition !== "sealed") {
      existing.remove();
    }
  });

  const save = async (extraPatch = {}) => {
    const patch = { ...readForm(), ...extraPatch };
    if (!patch.title) {
      toast("A tape needs a title.", { error: true });
      return false;
    }
    const btn = root.querySelector("[data-save]");
    btn.disabled = true;
    try {
      const { tape: updated } = await api.updateTape(tape.id, patch);
      upsertTapes([updated]);
      return true;
    } catch (err) {
      toast(err.message, { error: true });
      return false;
    } finally {
      btn.disabled = false;
    }
  };

  root.querySelector("[data-save]").addEventListener("click", async () => {
    if (await save()) {
      toast("Saved.");
      back();
    }
  });

  const openSoldSheet = ({ onCancel } = {}) => {
    let confirmed = false;
    const { close } = openSheet({
      title: "Mark as Sold",
      onClose: () => {
        if (!confirmed) onCancel?.();
      },
      content: `
        <div class="group">
          <label class="row"><span class="row-label">Sold For</span>
            ${priceField({ name: "soldFor", value: "", placeholder: tape.priceAsking != null ? String(tape.priceAsking) : "0" })}
          </label>
        </div>
        <div class="stack mt-16">
          <button class="btn" data-confirm-sold>${icons.dollar} Confirm Sale</button>
        </div>`,
    });
    wirePriceFields(document.getElementById("sheet-root"));
    document.querySelector("[data-confirm-sold]").addEventListener("click", async () => {
      const raw = document.querySelector("[name=soldFor]").value.replace(/[$,\s]/g, "");
      const soldFor = raw === "" ? tape.priceAsking : Number(raw);
      confirmed = true;
      close();
      if (
        await save({
          status: "sold",
          priceSold: Number.isFinite(soldFor) ? soldFor : null,
          soldDate: new Date().toISOString().slice(0, 10),
        })
      ) {
        await soldCelebration(root.querySelector(".detail-cover"));
        toast("Sold! 🎉");
        rerender();
      }
    });
  };

  const statusSelect = form.querySelector("[name=status]");
  statusSelect?.addEventListener("change", async (event) => {
    const newStatus = event.target.value;
    if (newStatus === "sold" && tape.status !== "sold") {
      // Route through the sold sheet so priceSold/soldDate get captured.
      openSoldSheet({ onCancel: () => (statusSelect.value = tape.status || "keep") });
    } else if (tape.status === "sold" && newStatus !== "sold") {
      if (await save()) rerender();
    }
  });

  root.querySelector("[data-marksold]")?.addEventListener("click", () => openSoldSheet());

  // ----- upload a new cover -----
  const coverInput = root.querySelector("[data-cover-file]");
  root.querySelector("[data-change-cover]").addEventListener("click", () => coverInput.click());
  coverInput.addEventListener("change", async () => {
    const file = coverInput.files?.[0];
    coverInput.value = "";
    if (!file) return;
    const editBtn = root.querySelector("[data-change-cover]");
    spinnerButtonStart(editBtn);
    try {
      const dataUrl = await resizeImage(file, 800, 0.88);
      const { tape: updated } = await api.uploadCover(tape.id, dataUrl);
      upsertTapes([updated]);
      toast("New cover saved. 📼");
      rerender();
    } catch (err) {
      toast(err.message, { error: true });
      spinnerButtonStop(editBtn);
    }
  });

  // ----- market value lookup -----
  root.querySelector("[data-value]").addEventListener("click", async () => {
    const current = readForm();
    const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
      [current.title, current.year, "VHS"].filter(Boolean).join(" ")
    )}&LH_Sold=1&LH_Complete=1`;
    const { body } = openSheet({
      title: "Market Value",
      content: `
        <div class="value-loading"><span class="spinner dark"></span><p class="centered-note">Sizing up “${esc(current.title)}”…</p></div>
        <div class="value-result" hidden></div>
        <div class="stack mt-16">
          <a class="btn gray" href="${esc(ebayUrl)}" target="_blank" rel="noopener">See Real Sold Prices on eBay</a>
        </div>
        <p class="hint" style="padding:10px 4px 0; text-align:center">Estimate from collector-market knowledge — always check live comps before pricing a rarity.</p>`,
    });
    try {
      const v = await api.valueEstimate({
        title: current.title,
        year: current.year,
        edition: current.edition,
        packaging: current.packaging,
        sealed: current.sealed,
        condition: current.condition,
      });
      const result = body.querySelector(".value-result");
      const demand = { hot: ["🔥 Hot demand", "var(--red)"], steady: ["📈 Steady seller", "var(--green)"], slow: ["🐢 Slow mover", "var(--label-secondary)"] }[v.demand];
      result.innerHTML = v.known && v.typical != null
        ? `
          <div class="value-hero">
            <div class="value-big">${money(v.typical)}</div>
            <div class="value-range">${v.low != null && v.high != null ? `${money(v.low)} – ${money(v.high)} range` : ""}</div>
            <div class="value-demand" style="color:${demand[1]}">${demand[0]}</div>
          </div>
          ${v.factors.length ? `<ul class="value-factors">${v.factors.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
          ${v.summary ? `<p class="centered-note" style="padding-top:6px">${esc(v.summary)}</p>` : ""}`
        : `<p class="centered-note">Not enough market history on this one — check the eBay sold listings below.</p>`;
      body.querySelector(".value-loading").hidden = true;
      result.hidden = false;
    } catch (err) {
      const loading = body.querySelector(".value-loading");
      if (loading) loading.innerHTML = `<p class="centered-note">${esc(err.message)}</p>`;
    }
  });

  root.querySelector("[data-relookup]").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    spinnerButtonStart(btn);
    try {
      const current = readForm();
      const { results } = await api.enrich([{ title: current.title, year: current.year }]);
      const hit = results?.[0];
      if (!hit?.matched) {
        toast("No details found for that title.", { error: true });
        return;
      }
      const { tape: updated } = await api.updateTape(tape.id, {
        ...current,
        title: hit.title || current.title,
        year: hit.year ?? current.year,
        director: hit.director || current.director,
        actors: hit.actors?.length ? hit.actors : current.actors,
        genre: hit.genre || current.genre,
        runtime: hit.runtime || tape.runtime,
        rated: hit.rated || tape.rated,
        plot: hit.plot || tape.plot,
        imdbRating: hit.imdbRating || tape.imdbRating,
        imdbId: hit.imdbId || tape.imdbId,
        posterUrl: hit.posterUrl || tape.posterUrl,
      });
      upsertTapes([updated]);
      toast("Details updated.");
      rerender();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      spinnerButtonStop(btn);
    }
  });

  root.querySelector("[data-delete]").addEventListener("click", async () => {
    const yes = await confirmSheet({
      title: "Delete Tape",
      message: `Remove “${tape.title}” from your library? This can't be undone.`,
    });
    if (!yes) return;
    try {
      await api.deleteTape(tape.id);
      removeTape(tape.id);
      toast("Deleted.");
      back();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function textRow(name, label, value, inputmode = "text", placeholder = "") {
  return `
    <label class="row"><span class="row-label">${esc(label)}</span>
      <input name="${name}" value="${esc(value ?? "")}" inputmode="${inputmode}" placeholder="${esc(placeholder)}" autocapitalize="${name === "title" || name === "director" || name === "actors" ? "words" : "off"}" />
    </label>`;
}
