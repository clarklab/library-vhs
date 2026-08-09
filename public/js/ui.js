// Sheets, toasts, and small shared UI helpers.

import { icons } from "./icons.js";
import { esc } from "./util.js";

const sheetRoot = () => document.getElementById("sheet-root");
const toastRoot = () => document.getElementById("toast-root");


/**
 * Opens an iOS-style bottom sheet. Returns { close, body } where body is the
 * scrollable content element. onClose fires after dismiss animation.
 */
export function openSheet({ title = "", content = "", onClose = null, showClose = true }) {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.innerHTML = `
    <div class="sheet-grabber"></div>
    <div class="sheet-header">
      <div class="sheet-title">${esc(title)}</div>
      ${showClose ? `<button class="nav-btn" data-close aria-label="Close">${icons.close}</button>` : "<span></span>"}
    </div>
    <div class="sheet-body"></div>`;
  const body = sheet.querySelector(".sheet-body");
  if (typeof content === "string") body.innerHTML = content;
  else if (content) body.appendChild(content);

  sheetRoot().appendChild(backdrop);
  sheetRoot().appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    sheet.classList.add("open");
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove("open");
    sheet.classList.remove("open");
    setTimeout(() => {
      backdrop.remove();
      sheet.remove();
      onClose?.();
    }, 320);
  };
  backdrop.addEventListener("click", close);
  sheet.querySelector("[data-close]")?.addEventListener("click", close);
  return { close, body, sheet };
}

let toastTimer;
export function toast(message, { error = false, duration = 2600 } = {}) {
  clearTimeout(toastTimer);
  toastRoot().innerHTML = "";
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `${error ? icons.info : icons.check}<span>${esc(message)}</span>`;
  toastRoot().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, duration);
}

/** iOS-style destructive confirm rendered as a sheet. Resolves boolean. */
export function confirmSheet({ title, message, confirmLabel = "Delete", destructive = true }) {
  return new Promise((resolve) => {
    let decided = false;
    const { close } = openSheet({
      title,
      showClose: false,
      onClose: () => {
        if (!decided) resolve(false);
      },
      content: `
        <p class="centered-note" style="padding-top:0">${esc(message)}</p>
        <div class="stack">
          <button class="btn ${destructive ? "destructive-filled" : ""}" data-yes>${esc(confirmLabel)}</button>
          <button class="btn gray" data-no>Cancel</button>
        </div>`,
    });
    sheetRoot()
      .querySelector("[data-yes]")
      .addEventListener("click", () => {
        decided = true;
        close();
        resolve(true);
      });
    sheetRoot()
      .querySelector("[data-no]")
      .addEventListener("click", () => {
        decided = true;
        close();
        resolve(false);
      });
  });
}

export function emptyState({ icon, title, message }) {
  return `
    <div class="empty fade-in">
      <div class="empty-icon">${icon}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
    </div>`;
}

/**
 * A money input with the dollar sign baked in and a scrub handle: drag the
 * handle left/right to dial the price in $1 steps (fast when you fling it),
 * or tap the number to type. Wire with wirePriceFields(container).
 */
export function priceField({ name, value = "", placeholder = "0" }) {
  const shown = value === null || value === undefined || value === "" ? "" : String(value);
  return `
    <span class="price-field" data-price-field>
      <span class="price-prefix">$</span>
      <input name="${esc(name)}" value="${esc(shown)}" inputmode="decimal" placeholder="${esc(placeholder)}" autocomplete="off" />
      <span class="price-scrub" data-price-scrub role="slider" aria-label="Drag to adjust price" tabindex="-1">${icons.scrub}</span>
    </span>`;
}

export function wirePriceFields(container) {
  container.querySelectorAll("[data-price-field]").forEach((field) => {
    const input = field.querySelector("input");
    const scrub = field.querySelector("[data-price-scrub]");
    if (!scrub || scrub.dataset.wired) return;
    scrub.dataset.wired = "1";

    const current = () => {
      const n = Number(String(input.value).replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    scrub.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startValue = current();
      field.classList.add("scrubbing");

      const move = (ev) => {
        const dx = ev.clientX - startX;
        // $1 per 7px, accelerating on bigger pulls so $5 → $80 is one gesture.
        const magnitude = Math.abs(dx) / 7;
        const step = Math.round(magnitude + Math.pow(magnitude / 6, 2));
        const next = Math.max(0, Math.round(startValue) + Math.sign(dx) * step);
        input.value = next === 0 && dx < 0 ? "" : String(next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const end = () => {
        field.classList.remove("scrubbing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
  });
}

export function spinnerButtonStart(btn, label = "") {
  btn.dataset.originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label ? esc(label) : ""}`;
}

export function spinnerButtonStop(btn) {
  btn.disabled = false;
  if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
}
