// Inline SVG icons, SF-Symbols-flavored. All take currentColor.

const svg = (inner, viewBox = "0 0 24 24") =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

// Google Material Symbols (Rounded), loaded from Google Fonts in index.html.
// Used for the tab bar and the library view/filter/sort controls.
const msym = (name) => `<span class="msym" aria-hidden="true">${name}</span>`;

export const icons = {
  library: msym("video_library"),
  stats: msym("bar_chart"),
  sales: msym("attach_money"),
  settings: msym("settings"),
  plus: msym("add"),
  camera: svg(
    `<path d="M4 8h2.2l1.4-2.2A2 2 0 0 1 9.3 5h5.4a2 2 0 0 1 1.7.8L17.8 8H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="14" r="3.4"/>`
  ),
  keyboard: svg(
    `<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>`
  ),
  listText: svg(`<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>`),
  fileCsv: svg(
    `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h1.5M8 17h8M12.5 13H16"/>`
  ),
  search: svg(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>`),
  grid: msym("grid_view"),
  rows: msym("view_agenda"),
  chevronRight: svg(`<path d="m9 6 6 6-6 6"/>`),
  chevronLeft: svg(`<path d="m15 6-6 6 6 6"/>`),
  check: svg(`<path d="m4.5 12.5 5 5 10-11"/>`, "0 0 24 24"),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  sparkles: svg(
    `<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>`
  ),
  tape: svg(
    `<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="8" cy="12" r="2.2"/><circle cx="16" cy="12" r="2.2"/><path d="M8 14.2h8"/>`
  ),
  sortArrows: msym("swap_vert"),
  table: msym("table"),
  trash: svg(
    `<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 11v6M14 11v6"/>`
  ),
  export: svg(`<path d="M12 15V3M12 3 8 7M12 3l4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>`),
  key: svg(`<circle cx="8" cy="14" r="4.5"/><path d="m11.5 10.5 8-8M16 5l3 3M13.5 7.5l3 3"/>`),
  logout: svg(`<path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"/><path d="M9 12h12l-3-3M21 12l-3 3"/>`),
  dollar: svg(
    `<circle cx="12" cy="12" r="9"/><path d="M12 7v10M14.5 9c0-1-1.1-1.6-2.5-1.6S9.5 8 9.5 9s.9 1.4 2.5 1.7 2.7.8 2.7 1.9-1.2 1.8-2.7 1.8-2.7-.7-2.7-1.7"/>`
  ),
  photo: svg(
    `<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m3.5 17 5-5 3.5 3.5L16 11l4.5 4.5"/>`
  ),
  info: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>`),
  scrub: svg(`<path d="m7.5 9-4 3 4 3M16.5 9l4 3-4 3M10.5 12h3"/>`),
  film: svg(
    `<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M7 3.5v17M17 3.5v17M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>`
  ),
};
