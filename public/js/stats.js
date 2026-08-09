// Stats, Sales, and Settings views.

import { api } from "./api.js";
import { icons } from "./icons.js";
import { esc, money, toCsv, downloadFile, statusLabel, conditionLabel } from "./util.js";
import { coverArt } from "./covers.js";
import { toast, emptyState, spinnerButtonStart, spinnerButtonStop, confirmSheet } from "./ui.js";
import { state, go, signOut } from "./app.js";

// ---------- Stats ----------

export function renderStats(root) {
  const tapes = state.tapes;
  const active = tapes.filter((t) => t.status !== "sold");
  const sold = tapes.filter((t) => t.status === "sold");

  const sum = (list, field) => list.reduce((acc, t) => acc + (Number(t[field]) || 0), 0);
  const invested = sum(tapes, "pricePaid");
  const askingTotal = sum(active, "priceAsking");
  const revenue = sum(sold, "priceSold");
  const soldCost = sum(sold, "pricePaid");

  const genreCounts = tally(tapes, (t) => (t.genre || "").split(",")[0].trim() || "Unknown");
  const decadeCounts = tally(
    tapes.filter((t) => t.year),
    (t) => `${Math.floor(t.year / 10) * 10}s`
  );
  const directorCounts = tally(
    tapes.filter((t) => t.director),
    (t) => t.director.split(",")[0].trim()
  );

  root.innerHTML = `
    <div class="screen">
      <div class="navbar"><div class="navbar-inner"><span></span><div class="nav-title">Stats</div><span></span></div></div>
      <h1 class="large-title">Stats</h1>

      ${
        tapes.length === 0
          ? emptyState({ icon: icons.stats, title: "Nothing to count yet", message: "Add some tapes and your collection stats will show up here." })
          : `
      <div class="stat-grid fade-in">
        <div class="stat-card">
          <div class="stat-label">In Collection</div>
          <div class="stat-value">${active.length}</div>
          <div class="stat-sub">${sold.length} sold all-time</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Asking Value</div>
          <div class="stat-value">${money(askingTotal) || "$0"}</div>
          <div class="stat-sub">across priced tapes</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Invested</div>
          <div class="stat-value">${money(invested) || "$0"}</div>
          <div class="stat-sub">total paid</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Sales Revenue</div>
          <div class="stat-value">${money(revenue) || "$0"}</div>
          <div class="stat-sub">${revenue - soldCost >= 0 ? "+" : ""}${money(revenue - soldCost) || "$0"} profit</div>
        </div>
      </div>

      ${barSection("Genres", genreCounts, "var(--tint)")}
      ${barSection("Decades", decadeCounts, "var(--purple)", true)}
      ${barSection("Top Directors", directorCounts, "var(--orange)")}
      `
      }
    </div>`;
}

function tally(list, keyFn) {
  const counts = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function barSection(title, entries, color, sortByName = false) {
  if (entries.length === 0) return "";
  const shown = sortByName ? [...entries].sort((a, b) => a[0].localeCompare(b[0])) : entries.slice(0, 8);
  const max = Math.max(...shown.map(([, n]) => n));
  return `
    <div class="section-pad">
      <div class="group-label" style="padding-left:0">${esc(title)}</div>
      <div class="group">
        ${shown
          .map(
            ([name, count]) => `
          <div class="bar-row">
            <div class="bar-name">${esc(name)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round((count / max) * 100)}%; background:${color}"></div></div>
            <div class="bar-count">${count}</div>
          </div>`
          )
          .join("")}
      </div>
    </div>`;
}

// ---------- Sales ----------

export function renderSales(root) {
  const sold = state.tapes
    .filter((t) => t.status === "sold")
    .sort((a, b) => (b.soldDate || b.updatedAt || "").localeCompare(a.soldDate || a.updatedAt || ""));

  const revenue = sold.reduce((acc, t) => acc + (Number(t.priceSold) || 0), 0);
  const cost = sold.reduce((acc, t) => acc + (Number(t.pricePaid) || 0), 0);

  root.innerHTML = `
    <div class="screen">
      <div class="navbar"><div class="navbar-inner"><span></span><div class="nav-title">Sales</div><span></span></div></div>
      <h1 class="large-title">Sales</h1>

      ${
        sold.length === 0
          ? emptyState({ icon: icons.sales, title: "No sales yet", message: "When you mark tapes as sold, they'll show up here with your running profit." })
          : `
      <div class="stat-grid fade-in">
        <div class="stat-card">
          <div class="stat-label">Revenue</div>
          <div class="stat-value">${money(revenue) || "$0"}</div>
          <div class="stat-sub">${sold.length} tape${sold.length === 1 ? "" : "s"} sold</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Profit</div>
          <div class="stat-value" style="color:${revenue - cost >= 0 ? "var(--green)" : "var(--red)"}">${money(revenue - cost) || "$0"}</div>
          <div class="stat-sub">after ${money(cost) || "$0"} cost</div>
        </div>
      </div>

      <div class="tape-list mt-8 fade-in">
        ${sold
          .map((tape) => {
            const profit = (Number(tape.priceSold) || 0) - (Number(tape.pricePaid) || 0);
            return `
          <button class="tape-row" data-tape="${esc(tape.id)}">
            <div class="tape-thumb">${coverArt(tape)}</div>
            <div class="tape-row-main">
              <div class="tape-row-title">${esc(tape.title)}</div>
              <div class="tape-row-sub">${tape.soldDate ? `Sold ${esc(tape.soldDate)}` : "Sold"}${tape.pricePaid != null ? ` · paid ${money(tape.pricePaid)}` : ""}</div>
            </div>
            <div class="tape-row-meta">
              <div class="tape-row-price">${money(tape.priceSold) || "—"}</div>
              <div class="tape-row-status" style="color:${profit >= 0 ? "var(--green)" : "var(--red)"}">${profit >= 0 ? "+" : ""}${money(profit) || "$0"}</div>
            </div>
          </button>`;
          })
          .join("")}
      </div>`
      }
    </div>`;

  root.querySelectorAll("[data-tape]").forEach((el) =>
    el.addEventListener("click", () => go("detail", el.dataset.tape))
  );
}

// ---------- Settings ----------

export function renderSettings(root) {
  root.innerHTML = `
    <div class="screen">
      <div class="navbar"><div class="navbar-inner"><span></span><div class="nav-title">Settings</div><span></span></div></div>
      <h1 class="large-title">Settings</h1>

      <div class="section-pad">
        <div class="group-label" style="padding-left:0">Account</div>
        <div class="group">
          <div class="row"><span class="row-label">Email</span><span class="row-value">${esc(state.user?.email || "")}</span></div>
          <div class="row"><span class="row-label">Tapes</span><span class="row-value">${state.tapes.length}</span></div>
        </div>

        <div class="group-label" style="padding-left:0">Movie Data</div>
        <div class="group">
          <label class="row stacked">
            <span class="field-label">OMDb API key (optional)</span>
            <input name="omdbKey" class="mini-input" style="background:var(--fill); border-radius:8px; padding:9px 10px; border:0; outline:none; text-align:left"
              placeholder="${state.user?.settings?.hasOmdbKey ? "••••••••  (key saved)" : "Paste key for real posters & ratings"}" autocapitalize="off" autocomplete="off" />
          </label>
          <button class="row tappable" data-save-key>
            <span class="row-label" style="color:var(--tint)">Save Key</span>
          </button>
        </div>
        <p class="hint" style="padding-left:0">Free at omdbapi.com — adds real cover art, IMDb ratings, and verified credits. Without it, the AI still fills in details and the app generates retro covers.</p>

        <div class="group-label" style="padding-left:0">Your Data</div>
        <div class="group">
          <button class="row tappable" data-export>
            <span class="row-label" style="color:var(--tint)">Export Library as CSV</span>
            <span class="row-value">${state.tapes.length} tapes</span>
          </button>
        </div>

        <div class="group mt-16">
          <button class="row tappable" data-signout>
            <span class="row-label" style="color:var(--red)">Sign Out</span>
          </button>
        </div>

        <p class="centered-note mt-24">VHS Vault · Be kind, rewind 📼<br/>Photo scanning powered by Claude via Netlify AI Gateway</p>
      </div>
    </div>`;

  root.querySelector("[data-save-key]").addEventListener("click", async (event) => {
    const input = root.querySelector("[name=omdbKey]");
    const key = input.value.trim();
    try {
      await api.saveSettings({ omdbKey: key });
      state.user.settings.hasOmdbKey = Boolean(key);
      toast(key ? "OMDb key saved." : "OMDb key removed.");
      input.value = "";
      input.placeholder = key ? "••••••••  (key saved)" : "Paste key for real posters & ratings";
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  root.querySelector("[data-export]").addEventListener("click", () => {
    if (state.tapes.length === 0) {
      toast("Nothing to export yet.", { error: true });
      return;
    }
    const headers = [
      "Title", "Year", "Director", "Actors", "Genre", "Runtime", "Rated", "Edition",
      "Condition", "Status", "Price Paid", "Asking Price", "Sold Price", "Sold Date",
      "Location", "Barcode", "Notes", "IMDb Rating", "IMDb ID", "Added",
    ];
    const rows = state.tapes.map((t) => [
      t.title, t.year ?? "", t.director, (t.actors || []).join("; "), t.genre, t.runtime,
      t.rated, t.edition, conditionLabel(t.condition) === "—" ? "" : t.condition,
      statusLabel(t.status), t.pricePaid ?? "", t.priceAsking ?? "", t.priceSold ?? "",
      t.soldDate ?? "", t.location, t.barcode, t.notes, t.imdbRating, t.imdbId,
      (t.createdAt || "").slice(0, 10),
    ]);
    downloadFile(`vhs-vault-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([headers, ...rows]));
    toast("CSV downloaded.");
  });

  root.querySelector("[data-signout]").addEventListener("click", async () => {
    const yes = await confirmSheet({
      title: "Sign Out",
      message: "Your library stays safely stored — sign back in anytime.",
      confirmLabel: "Sign Out",
      destructive: false,
    });
    if (yes) signOut();
  });
}
