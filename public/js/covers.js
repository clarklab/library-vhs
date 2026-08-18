// Generated VHS-box cover art for tapes without a poster.

import { esc } from "./util.js";

const PALETTES = [
  ["#1a1a2e", "#e94560", "#f7d060"], // midnight/red
  ["#0f3057", "#00b7c2", "#f6f6e9"], // ocean
  ["#2d132c", "#ee4540", "#f9d276"], // grindhouse
  ["#1b262c", "#3282b8", "#bbe1fa"], // sci-fi blue
  ["#2b580c", "#f7b71d", "#fdef96"], // jungle
  ["#3d0e1e", "#d90368", "#f5d547"], // neon
  ["#252525", "#ff6b35", "#efefd0"], // action orange
  ["#10316b", "#ffe867", "#fafafa"], // classic
  ["#472183", "#4b56d2", "#82c3ec"], // synth purple
  ["#4a1c40", "#f39189", "#f8ecd1"], // romance
];

const GENRE_PALETTE = {
  horror: 2,
  thriller: 0,
  "sci-fi": 3,
  "science fiction": 3,
  action: 6,
  adventure: 4,
  comedy: 5,
  drama: 9,
  romance: 9,
  fantasy: 8,
  crime: 0,
  western: 6,
  animation: 5,
  family: 4,
  documentary: 7,
  war: 6,
  mystery: 0,
  music: 8,
};

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function pickPalette(tape) {
  const genre = (tape.genre || "").toLowerCase();
  for (const [name, idx] of Object.entries(GENRE_PALETTE)) {
    if (genre.includes(name)) return PALETTES[idx];
  }
  return PALETTES[hash(tape.title || "?") % PALETTES.length];
}

function wrapTitle(title, maxChars = 10, maxLines = 4) {
  const words = String(title || "Untitled").toUpperCase().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if ((line + " " + word).length <= maxChars) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxChars - 1) + "…";
  }
  return lines.map((l) => (l.length > maxChars + 3 ? l.slice(0, maxChars + 2) + "…" : l));
}

/**
 * Returns an SVG string that looks like a VHS box spine/cover.
 * Used whenever a tape has no posterUrl.
 */
export function generatedCover(tape) {
  const [bg, accent, light] = pickPalette(tape);
  const lines = wrapTitle(tape.title);
  const h = hash(tape.title || "?");
  const angle = (h % 60) - 30;
  // Size to the longest line so the title never runs past the box edges,
  // even when the condensed font isn't available and a wider one is used.
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const fontSize = Math.max(14, Math.min(34, Math.round(172 / (longest * 0.6))));
  const lineHeight = fontSize * 1.08;
  const titleY = 132 - ((lines.length - 1) * lineHeight) / 2;

  const titleText = lines
    .map(
      (line, i) =>
        `<text x="100" y="${titleY + i * lineHeight}" text-anchor="middle" font-size="${fontSize}" font-family="'Arial Narrow', 'Helvetica Neue', Impact, sans-serif" font-weight="800" fill="${light}" letter-spacing="0.5">${esc(line)}</text>`
    )
    .join("");

  // 200x300 = 2:3, the same ratio as the cover box and OMDb poster art.
  return `<svg viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(tape.title)}">
  <defs>
    <linearGradient id="g${h}" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${angle} .5 .5)">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect width="200" height="300" fill="${bg}"/>
  <rect width="200" height="300" fill="url(#g${h})"/>
  <rect width="200" height="300" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="6"/>
  <rect x="0" y="0" width="200" height="30" fill="${accent}"/>
  <text x="12" y="21" font-size="14" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" fill="${bg}" letter-spacing="3">VHS</text>
  <text x="188" y="21" text-anchor="end" font-size="10" font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="${bg}" letter-spacing="1">HI-FI STEREO</text>
  ${titleText}
  <rect x="30" y="246" width="140" height="3" fill="${accent}"/>
  <text x="100" y="270" text-anchor="middle" font-size="15" font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="${light}" letter-spacing="2">${tape.year ? esc(String(tape.year)) : " "}</text>
  <text x="100" y="288" text-anchor="middle" font-size="8.5" font-family="Helvetica, Arial, sans-serif" fill="${light}" opacity="0.7" letter-spacing="1.5">${esc((tape.genre || "").split(",")[0].toUpperCase() || "FEATURE PRESENTATION")}</text>
</svg>`;
}

export function isSealed(tape) {
  return Boolean(tape.sealed) || tape.condition === "sealed";
}

/**
 * Shrink-wrap overlay for sealed tapes: a specular glint plus wrap wrinkles,
 * positioned by the global --tilt-x/--tilt-y vars so it slides with device
 * orientation like light moving across plastic.
 */
const SEAL_GLINT = `<span class="seal-glint" aria-hidden="true"></span>`;

/**
 * Cover markup: real poster <img> or generated SVG, plus seal glint when
 * sealed — all inside a single .box-front layer that owns the clipping.
 * Poster scans from OMDb/Amazon often carry baked-in white margins; on load
 * each poster is pixel-sampled and any detected margins are cropped off
 * (see __vhsTrimPoster). A small CSS bleed catches what sampling can't.
 */
export function coverArt(tape) {
  const art = tape.posterUrl
    ? `<img src="${esc(tape.posterUrl)}" alt="${esc(tape.title)}" loading="lazy" crossorigin="anonymous" onload="window.__vhsPosterLoaded(this)" onerror="window.__vhsPosterError(this)" data-t="${esc(JSON.stringify({ title: tape.title, year: tape.year, genre: tape.genre }))}">`
    : generatedCover(tape);
  return `<span class="box-front">${isSealed(tape) ? art + SEAL_GLINT : art}</span>`;
}

// Fallback hook for broken poster URLs (referenced from the onerror attribute).
window.__vhsFallbackCover = (json) => {
  try {
    return generatedCover(JSON.parse(json));
  } catch {
    return generatedCover({ title: "?" });
  }
};

// Poster hosts without CORS headers make a crossorigin <img> fail outright:
// retry plainly (poster shows, margins just can't be sampled) before giving
// up and drawing a generated cover.
window.__vhsPosterError = (img) => {
  if (img.crossOrigin && img.dataset.retried !== "1") {
    img.dataset.retried = "1";
    const src = img.src;
    img.removeAttribute("crossorigin");
    img.src = "";
    img.src = src;
    return;
  }
  img.outerHTML = window.__vhsFallbackCover(img.dataset.t);
};

/**
 * Decide how a poster should sit in its box. Art at (or near) the box's own
 * 2:3 ratio fills it edge to edge. Anything materially wider or squarer —
 * landscape banners, square scans — would lose most of its content to a
 * center crop, so it is shown whole over a blurred blow-up of itself.
 */
const BOX_RATIO = 2 / 3;
const RATIO_TOLERANCE = 0.14; // ~1/8 off before we stop cropping

function fitPoster(img) {
  const front = img.parentElement;
  if (!front || !front.classList.contains("box-front")) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return;
  const ratio = w / h;
  if (Math.abs(ratio - BOX_RATIO) / BOX_RATIO > RATIO_TOLERANCE) {
    front.style.setProperty("--poster", `url("${img.currentSrc || img.src}")`);
    front.classList.add("fit-contain");
  } else {
    front.classList.remove("fit-contain");
    front.style.removeProperty("--poster");
  }
}

/** Poster load hook: fit it to the box, then trim any baked-in scan borders. */
window.__vhsPosterLoaded = (img) => {
  fitPoster(img);
  window.__vhsTrimPoster(img);
};

/**
 * Trim baked-in scan borders. Downscales the poster to a small probe canvas,
 * walks inward from each edge while rows/columns are near-uniform white, and
 * if it finds real margins redraws the poster without them (cached per URL).
 * Runs only when CORS allows pixel reads; posters with clean edges (or
 * white-by-design art, which stays white past the search cap) are untouched.
 */
const trimCache = new Map(); // src -> trimmed data URL, or "" for "leave as-is"
const TRIM_CACHE_MAX = 200;

function rememberTrim(src, val) {
  if (trimCache.size >= TRIM_CACHE_MAX) trimCache.delete(trimCache.keys().next().value);
  trimCache.set(src, val);
}

window.__vhsTrimPoster = (img) => {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith("data:")) return;
  const cached = trimCache.get(src);
  if (cached !== undefined) {
    if (cached) img.src = cached;
    return;
  }
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;

    const PW = 48, PH = 72;      // probe resolution
    const WHITE = 224;           // per-pixel "white enough" luminance
    const ROW_FRAC = 0.94;       // fraction of a row/col that must be white
    const CAP = 0.1;             // deepest margin we'll believe (10%)
    const PAD = 0.008;           // shave the anti-aliased boundary line too

    const probe = document.createElement("canvas");
    probe.width = PW;
    probe.height = PH;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    pctx.drawImage(img, 0, 0, PW, PH);
    const d = pctx.getImageData(0, 0, PW, PH).data; // throws if CORS-tainted
    const lum = (x, y) => {
      const i = (y * PW + x) * 4;
      return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    };
    const rowWhite = (y) => {
      let n = 0;
      for (let x = 0; x < PW; x++) if (lum(x, y) > WHITE) n++;
      return n / PW >= ROW_FRAC;
    };
    const colWhite = (x) => {
      let n = 0;
      for (let y = 0; y < PH; y++) if (lum(x, y) > WHITE) n++;
      return n / PH >= ROW_FRAC;
    };
    // Walk in from an edge; hitting the cap while still white means the art
    // itself is white (minimalist poster) — leave that side alone.
    const run = (limit, isWhite) => {
      let n = 0;
      while (n < limit && isWhite(n)) n++;
      return n >= limit ? 0 : n;
    };
    const fT = run(Math.floor(PH * CAP), (n) => rowWhite(n)) / PH;
    const fB = run(Math.floor(PH * CAP), (n) => rowWhite(PH - 1 - n)) / PH;
    const fL = run(Math.floor(PW * CAP), (n) => colWhite(n)) / PW;
    const fR = run(Math.floor(PW * CAP), (n) => colWhite(PW - 1 - n)) / PW;

    if (fT + fB + fL + fR < 0.01) {
      rememberTrim(src, "");
      return;
    }
    const top = fT ? fT + PAD : 0;
    const bottom = fB ? fB + PAD : 0;
    const left = fL ? fL + PAD : 0;
    const right = fR ? fR + PAD : 0;
    const sx = Math.round(w * left);
    const sy = Math.round(h * top);
    const sw = Math.round(w * (1 - left - right));
    const sh = Math.round(h * (1 - top - bottom));
    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const url = out.toDataURL("image/jpeg", 0.92);
    rememberTrim(src, url);
    img.src = url;
  } catch {
    rememberTrim(src, ""); // CORS-tainted or decode issue — leave the poster be
  }
};
