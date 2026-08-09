// Library (grid/list) and tape detail/editor views.

import { api } from "./api.js";
import { icons } from "./icons.js";
import { esc, money, debounce, statusLabel, conditionLabel } from "./util.js";
import { coverArt } from "./covers.js";
import { toast, confirmSheet, emptyState, openSheet, spinnerButtonStart, spinnerButtonStop } from "./ui.js";
import { state, go, back, rerender, upsertTapes, removeTape } from "./app.js";

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
  if (filter !== "all") tapes = tapes.filter((t) => (t.status || "available") === filter);
  if (query) {
    const q = query.toLowerCase();
    tapes = tapes.filter((t) =>
      [t.title, t.director, t.genre, t.location, t.notes, ...(t.actors || []), ...(t.tags || [])]
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
      <div class="navbar">
        <div class="navbar-inner">
          <span></span>
          <div class="nav-title">Library</div>
          <button class="nav-btn" data-sort aria-label="Sort">${icons.sortArrows}</button>
        </div>
      </div>
      <h1 class="large-title">Library</h1>
      <div class="section-pad" style="padding-top:4px">
        <div style="display:flex; gap:10px; align-items:center;">
          <div class="searchbar" style="flex:1">
            ${icons.search}
            <input type="search" placeholder="Search titles, directors, boxes…" value="${esc(lib.query)}" data-search autocapitalize="off" />
          </div>
          <div class="segmented" style="flex:none">
            <button data-mode="grid" class="${lib.mode === "grid" ? "active" : ""}" aria-label="Cover view">${icons.grid}</button>
            <button data-mode="list" class="${lib.mode === "list" ? "active" : ""}" aria-label="List view">${icons.rows}</button>
          </div>
        </div>
      </div>
      <div class="chips" style="margin-top:6px">
        ${FILTERS.map(
          (f) => `<button class="chip${lib.filter === f.id ? " active" : ""}" data-filter="${f.id}">${f.label}${countFor(f.id)}</button>`
        ).join("")}
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
  if (filterId === "all") return state.tapes.length ? ` ${state.tapes.length}` : "";
  const n = state.tapes.filter((t) => (t.status || "available") === filterId).length;
  return n ? ` ${n}` : "";
}

function renderListContainer(container, tapes) {
  if (!state.loaded) {
    container.innerHTML = `<div class="centered-note"><span class="spinner dark" style="margin:0 auto"></span></div>`;
    return;
  }
  if (state.tapes.length === 0) {
    container.innerHTML = emptyState({
      icon: icons.tape,
      title: "No tapes yet",
      message: "Tap the + button and scan a photo of your tapes to get started.",
    });
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
      <div class="cover-grid fade-in">
        ${tapes.map(coverCell).join("")}
      </div>
      <div class="count-footer">${tapes.length} tape${tapes.length === 1 ? "" : "s"}</div>`;
  } else {
    container.innerHTML = `
      <div class="tape-list fade-in">
        ${tapes.map(listRow).join("")}
        <div class="count-footer">${tapes.length} tape${tapes.length === 1 ? "" : "s"}</div>
      </div>`;
  }
  container.querySelectorAll("[data-tape]").forEach((el) =>
    el.addEventListener("click", () => go("detail", el.dataset.tape))
  );
}

function coverCell(tape) {
  const status = tape.status || "available";
  const badge =
    status === "sold"
      ? `<span class="cover-badge badge-sold">Sold</span>`
      : status === "hold"
        ? `<span class="cover-badge badge-hold">Hold</span>`
        : status === "keep"
          ? `<span class="cover-badge badge-keep">Keep</span>`
          : "";
  return `
    <button class="cover-cell" data-tape="${esc(tape.id)}">
      <div class="cover-art">${coverArt(tape)}${badge}</div>
      <div class="cover-title">${esc(tape.title)}</div>
      <div class="cover-sub">${tape.year || ""}${tape.priceAsking != null && status !== "sold" ? `${tape.year ? " · " : ""}${money(tape.priceAsking)}` : ""}</div>
    </button>`;
}

function listRow(tape) {
  const status = tape.status || "available";
  const price = status === "sold" ? tape.priceSold ?? tape.priceAsking : tape.priceAsking;
  return `
    <button class="tape-row" data-tape="${esc(tape.id)}">
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
  const status = tape.status || "available";

  root.innerHTML = `
    <div class="screen no-tabs">
      <div class="navbar">
        <div class="navbar-inner">
          <button class="nav-btn" data-back>${icons.chevronLeft}<span>Library</span></button>
          <div class="nav-title">${esc(tape.title)}</div>
          <button class="nav-btn bold" data-save>Save</button>
        </div>
      </div>

      <div class="detail-hero fade-in">
        <div class="detail-cover">${coverArt(tape)}</div>
        <div class="detail-hero-main">
          <div class="detail-title">${esc(tape.title)}</div>
          <div class="detail-sub">${[tape.year, tape.rated, tape.runtime].filter(Boolean).map(esc).join(" · ")}</div>
          <div class="pill-row">
            ${(tape.genre || "").split(",").map((g) => g.trim()).filter(Boolean).map((g) => `<span class="pill">${esc(g)}</span>`).join("")}
            ${tape.imdbRating ? `<span class="pill">★ ${esc(tape.imdbRating)}</span>` : ""}
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
          ${textRow("edition", "Edition / Release", tape.edition, "text", "e.g. big box, ex-rental")}
        </div>

        <div class="group-label">Inventory</div>
        <div class="group">
          <label class="row"><span class="row-label">Status</span>
            <select name="status">
              ${["available", "hold", "keep", "sold"].map((s) => `<option value="${s}" ${status === s ? "selected" : ""}>${statusLabel(s)}</option>`).join("")}
            </select>
          </label>
          <label class="row"><span class="row-label">Condition</span>
            <select name="condition">
              <option value="">—</option>
              ${["sealed", "mint", "good", "fair", "poor"].map((c) => `<option value="${c}" ${tape.condition === c ? "selected" : ""}>${conditionLabel(c)}</option>`).join("")}
            </select>
          </label>
          ${textRow("pricePaid", "Price Paid", tape.pricePaid ?? "", "decimal", "$")}
          ${textRow("priceAsking", "Asking Price", tape.priceAsking ?? "", "decimal", "$")}
          ${status === "sold" ? textRow("priceSold", "Sold For", tape.priceSold ?? "", "decimal", "$") : ""}
          ${textRow("location", "Storage Location", tape.location, "text", "e.g. Box 3, garage shelf B")}
          ${textRow("barcode", "Barcode / UPC", tape.barcode, "numeric")}
        </div>

        <div class="group-label">Notes</div>
        <div class="group">
          <label class="row stacked">
            <textarea name="notes" placeholder="Condition details, provenance, what to tell buyers…">${esc(tape.notes || "")}</textarea>
          </label>
        </div>

        <div class="stack mt-24">
          ${status !== "sold" ? `<button type="button" class="btn tinted" data-marksold>${icons.dollar} Mark as Sold</button>` : ""}
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
      edition: val("edition").trim(),
      status: val("status"),
      condition: val("condition"),
      pricePaid: numOrNull("pricePaid"),
      priceAsking: numOrNull("priceAsking"),
      ...(form.querySelector("[name=priceSold]") ? { priceSold: numOrNull("priceSold") } : {}),
      location: val("location").trim(),
      barcode: val("barcode").trim(),
      notes: val("notes").trim(),
    };
  };

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
            <input name="soldFor" inputmode="decimal" placeholder="${tape.priceAsking != null ? money(tape.priceAsking) : "$"}" />
          </label>
        </div>
        <div class="stack mt-16">
          <button class="btn" data-confirm-sold>${icons.dollar} Confirm Sale</button>
        </div>`,
    });
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
      openSoldSheet({ onCancel: () => (statusSelect.value = tape.status || "available") });
    } else if (tape.status === "sold" && newStatus !== "sold") {
      if (await save()) rerender();
    }
  });

  root.querySelector("[data-marksold]")?.addEventListener("click", () => openSoldSheet());

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
