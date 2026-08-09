// Delight moments: tape-insert save animation, SOLD stamp + confetti,
// stat count-ups, the empty-state cassette mascot, and haptics.

import { esc, money } from "./util.js";

export function buzz(pattern = 10) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS Safari: no-op */
  }
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- 1. Tape-insert moment (saving tapes to the library) ----------

const CASSETTE_SVG = `
  <svg viewBox="0 0 120 74" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="116" height="70" rx="8" fill="#1c1c2e" stroke="#38e0ff" stroke-width="2.5"/>
    <rect x="14" y="12" width="92" height="34" rx="6" fill="#0d0d17"/>
    <circle cx="38" cy="29" r="10" fill="none" stroke="#38e0ff" stroke-width="3.5"/>
    <circle cx="82" cy="29" r="10" fill="none" stroke="#ff2d75" stroke-width="3.5"/>
    <path d="M48 29h24" stroke="#5a5a6e" stroke-width="3"/>
    <rect x="34" y="54" width="52" height="10" rx="3" fill="#f7d060"/>
  </svg>`;

/**
 * Full-screen beat: a cassette drops into a VCR slot, the slot glows,
 * then everything fades. Resolves when it's polite to navigate away.
 */
export function tapeInsertMoment(message = "Added to your library") {
  if (reduceMotion()) return Promise.resolve();
  buzz(15);
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "tape-moment";
    el.innerHTML = `
      <div class="tm-stage">
        <div class="tm-clip"><div class="tm-cassette">${CASSETTE_SVG}</div></div>
        <div class="tm-slot"><div class="tm-mouth"></div></div>
        <div class="tm-label">${esc(message)}</div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("run"));
    setTimeout(() => buzz(25), 620); // thunk as it lands in the slot
    setTimeout(() => el.classList.add("out"), 1250);
    setTimeout(() => {
      el.remove();
      resolve();
    }, 1550);
  });
}

// ---------- 2. SOLD stamp + confetti ----------

const CONFETTI = ["💵", "📼", "✨", "💰", "🤑"];

/** Slams a SOLD stamp over an element and bursts confetti from its center. */
export function soldCelebration(anchorEl) {
  buzz([18, 60, 24]);
  const rect =
    anchorEl?.getBoundingClientRect() ??
    { left: innerWidth / 2 - 60, top: innerHeight / 3, width: 120, height: 200 };
  // The anchor may be scrolled off-screen (e.g. confirming from the bottom of
  // a long form) — clamp so the celebration always plays in view.
  const cx = Math.min(Math.max(rect.left + rect.width / 2, 70), innerWidth - 70);
  const cy = Math.min(Math.max(rect.top + rect.height / 2, 140), innerHeight - 180);

  const stamp = document.createElement("div");
  stamp.className = "sold-stamp";
  stamp.textContent = "SOLD";
  stamp.style.left = `${cx}px`;
  stamp.style.top = `${cy}px`;
  document.body.appendChild(stamp);
  setTimeout(() => stamp.remove(), 1500);

  if (!reduceMotion()) {
    for (let i = 0; i < 28; i++) {
      const bit = document.createElement("span");
      bit.className = "confetti-bit";
      bit.textContent = CONFETTI[i % CONFETTI.length];
      bit.style.left = `${cx}px`;
      bit.style.top = `${cy}px`;
      document.body.appendChild(bit);
      const angle = Math.random() * Math.PI * 2;
      const distance = 90 + Math.random() * 170;
      const scale = 0.7 + Math.random() * 0.9;
      bit.animate(
        [
          { transform: `translate(-50%, -50%) rotate(0deg) scale(${scale})`, opacity: 1 },
          {
            transform: `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${
              Math.sin(angle) * distance - 60
            }px)) rotate(${(Math.random() * 2 - 1) * 300}deg) scale(${scale * 0.85})`,
            opacity: 0,
          },
        ],
        { duration: 950 + Math.random() * 550, easing: "cubic-bezier(.12,.8,.32,1)", fill: "forwards" }
      );
      setTimeout(() => bit.remove(), 1700);
    }
  }
  return new Promise((resolve) => setTimeout(resolve, 950));
}

// ---------- 6. Stat count-ups ----------

/**
 * Animates every [data-count] element from 0 to its value.
 * Add data-money for currency formatting.
 */
export function runCountUps(root) {
  if (reduceMotion()) return;
  root.querySelectorAll("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || target === 0) return;
    const isMoney = "money" in el.dataset;
    const start = performance.now();
    const duration = 750;
    const fmt = (v) => (isMoney ? money(v) || "$0" : String(Math.round(v)));
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(target * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- 4. Empty-state cassette mascot ----------

export function tapeMascot() {
  return `
  <svg class="mascot" viewBox="0 0 132 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="6" y="10" width="120" height="72" rx="10" fill="#1c1c2e" stroke="#38e0ff" stroke-width="3"/>
    <rect x="20" y="22" width="92" height="34" rx="6" fill="#0d0d17"/>
    <g class="mascot-reel" style="transform-origin:44px 39px">
      <circle cx="44" cy="39" r="11" fill="none" stroke="#38e0ff" stroke-width="3.5"/>
      <path d="M44 30v6M44 42v6M35 39h6M47 39h6" stroke="#38e0ff" stroke-width="2.5"/>
    </g>
    <g class="mascot-reel" style="transform-origin:88px 39px">
      <circle cx="88" cy="39" r="11" fill="none" stroke="#ff2d75" stroke-width="3.5"/>
      <path d="M88 30v6M88 42v6M79 39h6M91 39h6" stroke="#ff2d75" stroke-width="2.5"/>
    </g>
    <path d="M55 39h22" stroke="#5a5a6e" stroke-width="3"/>
    <rect x="42" y="64" width="48" height="11" rx="3.5" fill="#f7d060"/>
  </svg>`;
}
