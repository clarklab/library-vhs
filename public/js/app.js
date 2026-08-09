// VHS Vault — app shell: state, routing, auth, tab bar.

import { api, getToken, setToken } from "./api.js";
import { icons } from "./icons.js";
import { esc } from "./util.js";
import { toast } from "./ui.js";
import { renderLibrary, renderDetail } from "./library.js";
import { openAddSheet, renderScan, renderAddTitle, renderBulk, renderCsv } from "./addflows.js";
import { renderStats, renderSales, renderSettings } from "./stats.js";
import { initTilt } from "./tilt.js";

export const state = {
  user: null,
  tapes: [],
  loaded: false,
  view: "auth",
  viewArg: null,
  library: { mode: "grid", query: "", filter: "all", sort: "added" },
};

const app = () => document.getElementById("app");

// ---------- routing ----------

const TAB_VIEWS = ["library", "stats", "sales", "settings"];

export function go(view, arg = null, { replace = false } = {}) {
  state.view = view;
  state.viewArg = arg;
  const entry = { view, arg };
  if (replace) history.replaceState(entry, "");
  else history.pushState(entry, "");
  render();
}

export function back() {
  history.back();
}

window.addEventListener("popstate", (event) => {
  const entry = event.state;
  if (state.user) {
    state.view = entry?.view && entry.view !== "auth" ? entry.view : "library";
    state.viewArg = entry?.arg ?? null;
  } else {
    state.view = "auth";
  }
  render();
});

// ---------- data ----------

export async function refreshTapes() {
  const { tapes } = await api.listTapes();
  state.tapes = tapes;
  state.loaded = true;
}

export function upsertTapes(tapes) {
  for (const tape of tapes) {
    const idx = state.tapes.findIndex((t) => t.id === tape.id);
    if (idx >= 0) state.tapes[idx] = tape;
    else state.tapes.unshift(tape);
  }
}

export function removeTape(id) {
  state.tapes = state.tapes.filter((t) => t.id !== id);
}

// ---------- render ----------

export function render() {
  window.scrollTo(0, 0);
  const root = app();

  if (!state.user) {
    renderAuth(root);
    return;
  }

  switch (state.view) {
    case "library":
      renderLibrary(root);
      break;
    case "detail":
      renderDetail(root, state.viewArg);
      break;
    case "stats":
      renderStats(root);
      break;
    case "sales":
      renderSales(root);
      break;
    case "settings":
      renderSettings(root);
      break;
    case "scan":
      renderScan(root);
      break;
    case "addTitle":
      renderAddTitle(root);
      break;
    case "bulk":
      renderBulk(root);
      break;
    case "csv":
      renderCsv(root);
      break;
    default:
      renderLibrary(root);
  }

  if (TAB_VIEWS.includes(state.view)) {
    root.insertAdjacentHTML("beforeend", tabBar(state.view));
    wireTabBar(root);
  }
}

export function rerender() {
  render();
}

function tabBar(active) {
  const tab = (view, icon, label) => `
    <button class="tab${active === view ? " active" : ""}" data-tab="${view}" aria-label="${label}">
      ${icon}<span>${label}</span>
    </button>`;
  return `
    <nav class="tabbar">
      <div class="tabbar-inner">
        ${tab("library", icons.library, "Library")}
        ${tab("stats", icons.stats, "Stats")}
        <div class="tab-add">
          <button class="tab-add-btn" data-add aria-label="Add tapes">${icons.plus}</button>
        </div>
        ${tab("sales", icons.sales, "Sales")}
        ${tab("settings", icons.settings, "Settings")}
      </div>
    </nav>`;
}

function wireTabBar(root) {
  root.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.view !== btn.dataset.tab) go(btn.dataset.tab, null, { replace: true });
    });
  });
  root.querySelector("[data-add]")?.addEventListener("click", () => openAddSheet());
}

// ---------- auth screen ----------

function renderAuth(root) {
  let mode = "login";
  root.innerHTML = `
    <div class="auth-screen fade-in">
      <div class="auth-logo">
        <div class="logo-mark">${logoMark()}</div>
        <h1>VHS Vault</h1>
        <p>Your garage full of tapes, in your pocket.</p>
      </div>
      <div class="segmented" role="tablist">
        <button class="active" data-mode="login">Sign In</button>
        <button data-mode="signup">Create Account</button>
      </div>
      <form class="auth-form" novalidate>
        <input class="text-field" type="email" name="email" placeholder="Email" autocomplete="email" inputmode="email" autocapitalize="off" required />
        <input class="text-field" type="password" name="password" placeholder="Password" autocomplete="current-password" required />
        <div class="auth-error" role="alert"></div>
        <button class="btn" type="submit">Sign In</button>
      </form>
      <p class="centered-note mt-16">Track your collection, scan tapes with your camera,<br/>and price them for the next swap meet.</p>
    </div>`;

  const form = root.querySelector("form");
  const errorEl = root.querySelector(".auth-error");
  const submitBtn = form.querySelector("button[type=submit]");
  const passwordInput = form.querySelector("[name=password]");

  root.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      root.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b === btn));
      submitBtn.textContent = mode === "login" ? "Sign In" : "Create Account";
      passwordInput.autocomplete = mode === "login" ? "current-password" : "new-password";
      errorEl.textContent = "";
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      errorEl.textContent = "Enter your email and password.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span>`;
    try {
      const result = mode === "login" ? await api.login(email, password) : await api.signup(email, password);
      setToken(result.token);
      state.user = result.user;
      await loadAndEnter();
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "login" ? "Sign In" : "Create Account";
    }
  });
}

function logoMark() {
  return `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="18" width="88" height="60" rx="10" fill="#1c1c2e"/>
    <rect x="4" y="18" width="88" height="60" rx="10" fill="none" stroke="url(#lg)" stroke-width="3"/>
    <circle cx="30" cy="48" r="10" fill="none" stroke="#38e0ff" stroke-width="4"/>
    <circle cx="66" cy="48" r="10" fill="none" stroke="#ff2d75" stroke-width="4"/>
    <path d="M30 62h36" stroke="#f7d060" stroke-width="4" stroke-linecap="round"/>
    <defs>
      <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#38e0ff"/>
        <stop offset="0.5" stop-color="#af52de"/>
        <stop offset="1" stop-color="#ff2d75"/>
      </linearGradient>
    </defs>
  </svg>`;
}

// ---------- boot ----------

async function loadAndEnter() {
  try {
    await refreshTapes();
  } catch (err) {
    toast(err.message, { error: true });
  }
  go("library", null, { replace: true });
}

window.addEventListener("vhs:signed-out", () => {
  state.user = null;
  state.tapes = [];
  state.loaded = false;
  state.view = "auth";
  render();
  toast("Signed out.", {});
});

export async function signOut() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  setToken(null);
  state.user = null;
  state.tapes = [];
  state.loaded = false;
  go("auth", null, { replace: true });
}

async function boot() {
  if (getToken()) {
    try {
      const { user } = await api.me();
      state.user = user;
      await loadAndEnter();
      return;
    } catch (err) {
      if (err.status === 401) {
        setToken(null); // session genuinely expired
      } else {
        renderOffline(err);
        return; // network/server hiccup — keep the session, offer retry
      }
    }
  }
  state.view = "auth";
  history.replaceState({ view: "auth" }, "");
  render();
}

function renderOffline(err) {
  app().innerHTML = `
    <div class="auth-screen fade-in">
      <div class="auth-logo">
        <div class="logo-mark">${logoMark()}</div>
        <h1>VHS Vault</h1>
        <p>${esc(err?.status === 0 ? "You appear to be offline." : "Couldn't reach the server.")}</p>
      </div>
      <button class="btn mt-16" data-retry>Try Again</button>
    </div>`;
  app().querySelector("[data-retry]").addEventListener("click", () => {
    app().querySelector("[data-retry]").innerHTML = `<span class="spinner"></span>`;
    boot();
  });
}

initTilt();
boot();
