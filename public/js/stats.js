// Stats, Sales, and Settings views.

import { icons } from "./icons.js";
import { esc, money, statusLabel, conditionLabel } from "./util.js";
import { coverArt } from "./covers.js";
import { emptyState } from "./ui.js";
import { state, go } from "./app.js";
import { runCountUps } from "./delight.js";
import { columnChart, barList, areaChart, monthlyRevenue, wireChartTips } from "./charts.js";

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
      <div class="stat-grid">
        <div class="stat-card" style="--i:0">
          <div class="stat-label">In Collection</div>
          <div class="stat-value" data-count="${active.length}">${active.length}</div>
          <div class="stat-sub">${sold.length} sold all-time</div>
        </div>
        <div class="stat-card" style="--i:1">
          <div class="stat-label">Asking Value</div>
          <div class="stat-value" data-count="${askingTotal}" data-money>${money(askingTotal) || "$0"}</div>
          <div class="stat-sub">across priced tapes</div>
        </div>
        <div class="stat-card" style="--i:2">
          <div class="stat-label">Invested</div>
          <div class="stat-value" data-count="${invested}" data-money>${money(invested) || "$0"}</div>
          <div class="stat-sub">total paid</div>
        </div>
        <div class="stat-card" style="--i:3">
          <div class="stat-label">Sales Revenue</div>
          <div class="stat-value" data-count="${revenue}" data-money>${money(revenue) || "$0"}</div>
          <div class="stat-sub">${revenue - soldCost >= 0 ? "+" : ""}${money(revenue - soldCost) || "$0"} profit</div>
        </div>
      </div>

      ${chartSection("By Decade", columnChart([...decadeCounts].sort((a, b) => a[0].localeCompare(b[0])), { hue: "var(--tint)" }))}
      ${chartSection("Genres", barList(genreCounts.slice(0, 8), { hue: "var(--purple)", total: tapes.length }))}
      ${chartSection("Top Directors", barList(directorCounts.slice(0, 8), { hue: "var(--orange)" }))}
      `
      }
    </div>`;

  runCountUps(root);
  wireChartTips(root);
}

function chartSection(title, markup) {
  if (!markup) return "";
  return `
    <div class="section-pad">
      <div class="group-label" style="padding-left:0">${esc(title)}</div>
      <div class="group chart-card">${markup}</div>
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
      <div class="stat-grid">
        <div class="stat-card" style="--i:0">
          <div class="stat-label">Revenue</div>
          <div class="stat-value" data-count="${revenue}" data-money>${money(revenue) || "$0"}</div>
          <div class="stat-sub">${sold.length} tape${sold.length === 1 ? "" : "s"} sold</div>
        </div>
        <div class="stat-card" style="--i:1">
          <div class="stat-label">Profit</div>
          <div class="stat-value" style="color:${revenue - cost >= 0 ? "var(--green)" : "var(--red)"}" data-count="${revenue - cost}" data-money>${money(revenue - cost) || "$0"}</div>
          <div class="stat-sub">after ${money(cost) || "$0"} cost</div>
        </div>
      </div>

      ${(() => {
        const series = monthlyRevenue(sold);
        return series.length >= 2
          ? `<div class="section-pad" style="padding-bottom:0"><div class="group-label" style="padding-left:0">Revenue by Month</div><div class="group chart-card">${areaChart(series, { hue: "var(--green)" })}</div></div>`
          : "";
      })()}

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
  runCountUps(root);
  wireChartTips(root);
}

export { renderSettings } from "./account.js";
