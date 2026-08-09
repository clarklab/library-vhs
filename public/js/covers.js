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

function wrapTitle(title, maxChars = 11, maxLines = 4) {
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
  const fontSize = lines.some((l) => l.length > 9) ? 30 : 36;
  const lineHeight = fontSize * 1.08;
  const titleY = 150 - ((lines.length - 1) * lineHeight) / 2;

  const titleText = lines
    .map(
      (line, i) =>
        `<text x="105" y="${titleY + i * lineHeight}" text-anchor="middle" font-size="${fontSize}" font-family="'Arial Narrow', 'Helvetica Neue', Impact, sans-serif" font-weight="800" fill="${light}" letter-spacing="0.5">${esc(line)}</text>`
    )
    .join("");

  return `<svg viewBox="0 0 210 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(tape.title)}">
  <defs>
    <linearGradient id="g${h}" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${angle} .5 .5)">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect width="210" height="360" fill="${bg}"/>
  <rect width="210" height="360" fill="url(#g${h})"/>
  <rect width="210" height="360" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="6"/>
  <rect x="0" y="0" width="210" height="34" fill="${accent}"/>
  <text x="12" y="23" font-size="15" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" fill="${bg}" letter-spacing="3">VHS</text>
  <text x="198" y="23" text-anchor="end" font-size="11" font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="${bg}" letter-spacing="1">HI-FI STEREO</text>
  ${titleText}
  <rect x="30" y="300" width="150" height="3" fill="${accent}"/>
  <text x="105" y="326" text-anchor="middle" font-size="16" font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="${light}" letter-spacing="2">${tape.year ? esc(String(tape.year)) : " "}</text>
  <text x="105" y="346" text-anchor="middle" font-size="9" font-family="Helvetica, Arial, sans-serif" fill="${light}" opacity="0.7" letter-spacing="1.5">${esc((tape.genre || "").split(",")[0].toUpperCase() || "FEATURE PRESENTATION")}</text>
</svg>`;
}

/** Cover markup: real poster <img> or generated SVG. */
export function coverArt(tape) {
  if (tape.posterUrl) {
    return `<img src="${esc(tape.posterUrl)}" alt="${esc(tape.title)}" loading="lazy" onerror="this.outerHTML=window.__vhsFallbackCover(this.dataset.t)" data-t="${esc(JSON.stringify({ title: tape.title, year: tape.year, genre: tape.genre }))}">`;
  }
  return generatedCover(tape);
}

// Fallback hook for broken poster URLs (referenced from the onerror attribute).
window.__vhsFallbackCover = (json) => {
  try {
    return generatedCover(JSON.parse(json));
  } catch {
    return generatedCover({ title: "?" });
  }
};
