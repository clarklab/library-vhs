// Add-to-Home-Screen: service worker registration + the install offer sheet.
//
// Android/Chromium: we capture `beforeinstallprompt` and trigger the real
// native install dialog from our sheet. iOS Safari has no install API, so the
// sheet walks through Share → Add to Home Screen with drawn icons.

import { openSheet, toast } from "./ui.js";
import { buzz } from "./delight.js";

const INSTALLED_KEY = "vhsvault.installed";
const DISMISSED_KEY = "vhsvault.installDismissedAt";
const REOFFER_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // ask again after a week

let deferredPrompt = null;
let offeredThisSession = false;

export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  const ua = navigator.userAgent;
  const classic = /iPhone|iPad|iPod/i.test(ua);
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return classic || iPadOS;
}

export function initInstall() {
  // Service worker: keeps the app working offline; network-first inside it
  // means every launch online pulls the newest deploy.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // we present it from our own sheet
    deferredPrompt = event;
    // Chrome often decides installability AFTER our post-login offer ran —
    // if the user is already in the app, offer now instead of never.
    if (!offeredThisSession && document.querySelector(".tabbar")) {
      setTimeout(() => maybeOfferInstall(), 900);
    }
  });

  window.addEventListener("appinstalled", () => {
    localStorage.setItem(INSTALLED_KEY, "1");
    deferredPrompt = null;
    toast("VHS Vault is on your Home Screen. 📼");
  });

  if (isStandalone()) localStorage.setItem(INSTALLED_KEY, "1");
}

/** True when there's a reason to offer at all on this device/browser. */
function canOffer() {
  if (isStandalone()) return false;
  if (localStorage.getItem(INSTALLED_KEY)) return false;
  return Boolean(deferredPrompt) || isIOS();
}

/**
 * Auto-offer after auth. Respects a week-long snooze after "Maybe Later";
 * `manual` (from Settings) always shows.
 */
export function maybeOfferInstall({ manual = false } = {}) {
  if (navigator.webdriver && !manual) return; // don't interfere with tests
  if (!manual) {
    if (offeredThisSession) return;
    const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) || 0);
    if (Date.now() - dismissedAt < REOFFER_AFTER_MS) return;
    if (!canOffer()) return;
    offeredThisSession = true;
  }
  showInstallSheet({ manual });
}

const SHARE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M12 3 8 7M12 3l4 4"/><path d="M5 10v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9"/></svg>`;
const PLUS_SQUARE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`;

function benefits() {
  return `
    <div class="install-benefits">
      <div class="install-benefit">⚡️ <span>Launches full-screen, instantly</span></div>
      <div class="install-benefit">📷 <span>One tap from pocket to scanning tapes</span></div>
      <div class="install-benefit">📦 <span>Keeps working with spotty swap-meet signal</span></div>
      <div class="install-benefit">🔄 <span>Updates itself automatically</span></div>
    </div>`;
}

function showInstallSheet({ manual }) {
  if (isStandalone()) {
    toast("Already installed — you're using it right now. 📼");
    return;
  }
  buzz(8);

  const ios = isIOS() && !deferredPrompt;
  const canNativePrompt = Boolean(deferredPrompt);

  let acted = false;
  const { close } = openSheet({
    title: "",
    showClose: false,
    onClose: () => {
      if (!acted && !manual) localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    },
    content: `
      <div class="install-sheet">
        <img class="install-appicon" src="/icon-192.png" alt="" width="76" height="76" />
        <h3>Put VHS Vault on your Home Screen</h3>
        <p class="install-sub">Make it a real app — no browser bars, no typing addresses at the swap meet.</p>
        ${benefits()}
        ${
          ios
            ? `
        <div class="install-steps">
          <div class="install-step"><span class="install-step-icon">${SHARE_ICON}</span><span>Tap the <strong>Share</strong> button below</span></div>
          <div class="install-step"><span class="install-step-icon">${PLUS_SQUARE_ICON}</span><span>Choose <strong>Add to Home Screen</strong></span></div>
          <div class="install-step"><span class="install-step-icon">📼</span><span>Tap <strong>Add</strong> — that's it</span></div>
        </div>
        <button class="btn gray" data-install-later>Got It</button>`
            : canNativePrompt
              ? `
        <div class="stack">
          <button class="btn" data-install-now>${PLUS_SQUARE_ICON} Add to Home Screen</button>
          <button class="btn gray" data-install-later>Maybe Later</button>
        </div>`
              : `
        <p class="centered-note">In your browser menu, choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</p>
        <button class="btn gray" data-install-later>Got It</button>`
        }
      </div>`,
  });

  const root = document.getElementById("sheet-root");
  root.querySelector("[data-install-later]")?.addEventListener("click", () => {
    if (!manual) localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    acted = true;
    close();
  });
  root.querySelector("[data-install-now]")?.addEventListener("click", async () => {
    acted = true;
    const prompt = deferredPrompt;
    close();
    if (!prompt) return;
    deferredPrompt = null;
    try {
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === "accepted") {
        localStorage.setItem(INSTALLED_KEY, "1");
        buzz([10, 40, 10]);
      } else {
        localStorage.setItem(DISMISSED_KEY, String(Date.now()));
      }
    } catch {
      /* prompt already used or unavailable */
    }
  });
}
