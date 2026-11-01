// Code-native brand artwork: small, sharp and available offline.
export function brandMark() {
  return `<span class="brand-mark" aria-hidden="true"><img src="/icon.svg" alt="" width="41" height="41" decoding="async"></span>`;
}

const REEL = `<svg class="tape-reel" viewBox="-131 -131 262 262" aria-hidden="true"><circle r="129.5" fill="#434247" stroke="#3F3E42" stroke-width="3"/><circle r="68" fill="#C6C6C6"/><path d="M0-42 8.7-32.5 21-36.4 23.8-23.8 36.4-21 32.5-8.7 42 0 32.5 8.7 36.4 21 23.8 23.8 21 36.4 8.7 32.5 0 42-8.7 32.5-21 36.4-23.8 23.8-36.4 21-32.5 8.7-42 0-32.5-8.7-36.4-21-23.8-23.8-21-36.4-8.7-32.5Z" fill="#1E1818"/></svg>`;

/** The app icon at page scale: five stripes running into a cassette's notched edge. */
export function tapeEdge() {
  return `<div class="tape-stripes" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="tape-edge" aria-hidden="true">${REEL}${REEL}<span class="tape-spine"><i></i><i></i></span><span class="tape-square"></span></div>`;
}

export function cassetteArt() {
  return `<div class="cassette-scene" aria-hidden="true"><div class="cassette-shadow"></div><div class="cassette"><div class="cassette-edge"></div><div class="cassette-label"><div class="cassette-label-top"><span>THE GOOD STUFF</span><span>120</span></div><div class="cassette-window"><i class="reel"></i><span class="tape-window-lines"></span><i class="reel"></i></div><div class="cassette-label-bottom"><span>YOUR COLLECTION, ON RECORD.</span><b>VHS</b></div></div><div class="cassette-base"><i></i><span>HI-FI STEREO</span><i></i></div><span class="screw s1"></span><span class="screw s2"></span><span class="screw s3"></span><span class="screw s4"></span></div><div class="cassette-sticker">BE KIND.<br>REWIND. <span>↗</span></div></div>`;
}
