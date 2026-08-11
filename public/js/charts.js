// Tiny SVG chart kit for Stats/Sales — zero dependencies, styled to the app.
//
// Design rules baked in: one hue per chart (magnitude, not identity), thin
// marks with rounded data-ends and square baselines, direct labels in text
// ink (never colored), recessive baselines, tap-to-inspect tooltips, and
// animations that respect prefers-reduced-motion (CSS-driven).

import { esc, money } from "./util.js";

let uid = 0;

/**
 * Vertical columns for a small ordered set (e.g. decades).
 * entries: [[label, count]] in display order.
 */
export function columnChart(entries, { hue = "var(--tint)" } = {}) {
  if (!entries.length) return "";
  const id = `col${++uid}`;
  const n = entries.length;
  const W = Math.max(320, n * 54);
  const H = 156;
  const baseline = H - 22; // room for x labels
  const top = 22; // room for count labels
  const max = Math.max(...entries.map(([, v]) => v));
  const band = W / n;
  const barW = Math.min(34, band * 0.55);

  const cols = entries
    .map(([label, value], i) => {
      const h = Math.max(6, ((baseline - top) * value) / max);
      const x = band * i + (band - barW) / 2;
      const y = baseline - h;
      return `
      <g class="ck-col" style="--i:${i}" data-tip="${esc(label)} · ${value} tape${value === 1 ? "" : "s"}">
        <rect class="ck-hit" x="${band * i}" y="0" width="${band}" height="${H}" fill="transparent"/>
        <rect class="ck-bar" x="${x}" y="${y}" width="${barW}" height="${h + 4}" rx="4"
          fill="url(#${id}g)" clip-path="url(#${id}c)" style="transform-origin: ${x + barW / 2}px ${baseline}px"/>
        <text class="ck-val" x="${x + barW / 2}" y="${y - 7}" text-anchor="middle">${value}</text>
        <text class="ck-lab" x="${band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>
      </g>`;
    })
    .join("");

  return `
  <div class="chart-scroll">
    <svg class="chartkit" viewBox="0 0 ${W} ${H}" style="--hue:${hue}; min-width:${W}px" role="img">
      <defs>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${hue}"/>
          <stop offset="1" stop-color="${hue}" stop-opacity="0.55"/>
        </linearGradient>
        <clipPath id="${id}c"><rect x="0" y="0" width="${W}" height="${baseline}"/></clipPath>
      </defs>
      <line class="ck-base" x1="0" y1="${baseline}" x2="${W}" y2="${baseline}"/>
      ${cols}
    </svg>
  </div>`;
}

/**
 * Horizontal bar list for top-N categories (e.g. genres, directors).
 * entries: [[label, count]] sorted desc.
 */
export function barList(entries, { hue = "var(--tint)", total = 0 } = {}) {
  if (!entries.length) return "";
  const max = Math.max(...entries.map(([, v]) => v));
  return `
  <div class="barlist" style="--hue:${hue}">
    ${entries
      .map(([label, value], i) => {
        const pct = total ? ` · ${Math.round((value / total) * 100)}%` : "";
        return `
      <button class="bl-row" style="--i:${i}" data-tip="${esc(label)} · ${value}${pct}">
        <span class="bl-name">${esc(label)}</span>
        <span class="bl-track"><span class="bl-fill" style="width:${Math.max(3, Math.round((value / max) * 100))}%"></span></span>
        <span class="bl-count">${value}</span>
      </button>`;
      })
      .join("")}
  </div>`;
}

/**
 * Area chart over months (e.g. revenue). points: [[isoMonth "YYYY-MM", value]]
 * sorted ascending, gaps already filled with zeros.
 */
export function areaChart(points, { hue = "var(--green)", isMoney = true } = {}) {
  if (points.length < 2) return "";
  const id = `area${++uid}`;
  const W = 340;
  const H = 148;
  const padL = 6, padR = 40, padT = 26, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...points.map(([, v]) => v)) || 1;
  const xy = points.map(([, v], i) => [
    padL + (innerW * i) / (points.length - 1),
    padT + innerH - (innerH * v) / max,
  ]);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)} ${padT + innerH} L${xy[0][0].toFixed(1)} ${padT + innerH} Z`;

  const fmt = (v) => (isMoney ? money(v) || "$0" : String(v));
  const monthLabel = (iso) => {
    const [y, m] = iso.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "short" });
  };
  const last = points.length - 1;

  const dots = xy
    .map(([x, y], i) => `
      <g class="ck-dot-g" data-tip="${esc(monthLabel(points[i][0]))} ${points[i][0].slice(0, 4)} · ${esc(fmt(points[i][1]))}">
        <circle class="ck-hit" cx="${x}" cy="${y}" r="14" fill="transparent"/>
        <circle class="ck-dot" cx="${x}" cy="${y}" r="${i === last ? 4.5 : 3.5}"/>
      </g>`)
    .join("");

  // x labels: first, last, and middle if room
  const labelIdx = points.length > 4 ? [0, Math.floor(last / 2), last] : points.map((_, i) => i);
  const xLabels = labelIdx
    .map((i) => `<text class="ck-lab" x="${xy[i][0]}" y="${H - 5}" text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}">${esc(monthLabel(points[i][0]))}</text>`)
    .join("");

  return `
  <svg class="chartkit ck-area" viewBox="0 0 ${W} ${H}" style="--hue:${hue}" role="img">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${hue}" stop-opacity="0.35"/>
        <stop offset="1" stop-color="${hue}" stop-opacity="0.02"/>
      </linearGradient>
      <clipPath id="${id}c"><rect class="ck-reveal" x="0" y="0" width="${W}" height="${H}"/></clipPath>
    </defs>
    <line class="ck-base" x1="${padL}" y1="${padT + innerH}" x2="${W - padR + 20}" y2="${padT + innerH}"/>
    <g clip-path="url(#${id}c)">
      <path class="ck-fill" d="${area}" fill="url(#${id}g)"/>
      <path class="ck-line" d="${line}"/>
    </g>
    ${dots}
    <text class="ck-val ck-val-last" x="${xy[last][0] + 8}" y="${xy[last][1] + 4}">${esc(fmt(points[last][1]))}</text>
    ${xLabels}
  </svg>`;
}

/** Groups sold tapes into a zero-filled month series of revenue. */
export function monthlyRevenue(sold) {
  const byMonth = new Map();
  for (const t of sold) {
    const iso = (t.soldDate || t.updatedAt || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(iso)) continue;
    byMonth.set(iso, (byMonth.get(iso) || 0) + (Number(t.priceSold) || 0));
  }
  const keys = [...byMonth.keys()].sort();
  if (keys.length === 0) return [];
  // fill gaps so the time axis is honest
  const out = [];
  let [y, m] = keys[0].split("-").map(Number);
  const [ey, em] = keys[keys.length - 1].split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const iso = `${y}-${String(m).padStart(2, "0")}`;
    out.push([iso, byMonth.get(iso) || 0]);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out.slice(-12); // last year at most
}

/** Tap-to-inspect tooltips for anything carrying data-tip. */
export function wireChartTips(root) {
  let tip = null;
  const dismiss = () => {
    tip?.remove();
    tip = null;
  };
  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-tip]");
    if (!target) {
      dismiss();
      return;
    }
    dismiss();
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.textContent = target.dataset.tip;
    document.body.appendChild(tip);
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2 - tr.width / 2, 8), window.innerWidth - tr.width - 8);
    const y = r.top - tr.height - 8 > 8 ? r.top - tr.height - 8 : r.bottom + 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add("show");
    setTimeout(dismiss, 2600);
  });
}
