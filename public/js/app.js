// VHS Vault — app shell: state, routing, auth, tab bar.

import { api, getToken, setToken } from "./api.js";
import { icons } from "./icons.js";
import { esc } from "./util.js";
import { toast, closeAllSheets } from "./ui.js";
import { renderLibrary, renderDetail } from "./library.js";
import {
  renderScan,
  renderAddTitle,
  renderBulk,
} from "./addflows.js";
import { renderScouts } from "./scouts.js";
import { renderStats, renderSales, renderSettings } from "./stats.js";
import { pauseScanSession, disposeScanSession } from "./scan-session.js";
import { brandMark } from "./brand.js";
import { renderAuth as renderAuthView } from "./auth-view.js";
import { renderBackup, disposeBackup } from "./backup.js";
import { initInstall, maybeOfferInstall } from "./install.js";

export const state = {
  user: null,
  tapes: [],
  loaded: false,
  loadError: "",
  view: "auth",
  viewArg: null,
  library: { mode: "grid", query: "", filter: "all", sort: "added" },
};

const app = () => document.getElementById("app");

// ---------- routing ----------

export function go(view, arg = null, { replace = false } = {}) {
  if (view === "csv") view = "backup";
  const fromView = state.view;
  const fromArg = state.viewArg;
  disposeBackup();
  if (fromView === "scan" && view !== "scan") pauseScanSession();
  state.view = view;
  state.viewArg = arg;
  const entry = { view, arg };
  if (replace) history.replaceState(entry, "");
  else history.pushState(entry, "");
  renderWithTransition(fromView, fromArg);
}

export function back() {
  history.back();
}

window.addEventListener("popstate", (event) => {
  disposeBackup();
  const entry = event.state;
  if (entry?.view === "csv") entry.view = "backup";
  if (state.view === "scan" && entry?.view !== "scan") pauseScanSession();
  const fromView = state.view;
  const fromArg = state.viewArg;
  if (state.user) {
    state.view = entry?.view && entry.view !== "auth" ? entry.view : "library";
    state.viewArg = entry?.arg ?? null;
  } else {
    state.view = "auth";
  }
  renderWithTransition(fromView, fromArg);
});

/**
 * Detail opens/closes with a shared-element transition: the tapped cover
 * morphs into the detail hero (and back) while the detail screen slides up
 * like a sheet. Everything else renders plainly.
 */
function renderWithTransition(fromView, fromArg) {
  const entering = state.view === "detail" && fromView !== "detail";
  const leaving = fromView === "detail" && state.view !== "detail";
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (
    !document.startViewTransition ||
    reduceMotion ||
    (!entering && !leaving)
  ) {
    render();
    return;
  }

  // Entering: tag the tapped cover so the browser pairs it with the detail
  // hero (which carries the same view-transition-name in its markup).
  const sourceCover = entering
    ? document.querySelector(
        `[data-tape="${CSS.escape(state.viewArg ?? "")}"] .cover-art, [data-tape="${CSS.escape(state.viewArg ?? "")}"] .tape-thumb`,
      )
    : null;
  if (sourceCover) sourceCover.style.viewTransitionName = "tape-poster";

  let destCover = null;
  const transition = document.startViewTransition(() => {
    render();
    if (leaving && fromArg) {
      // Returning: pair the detail hero we just left with its library cell.
      destCover = document.querySelector(
        `[data-tape="${CSS.escape(fromArg)}"] .cover-art, [data-tape="${CSS.escape(fromArg)}"] .tape-thumb`,
      );
      if (destCover) destCover.style.viewTransitionName = "tape-poster";
    }
  });
  transition.finished.finally(() => {
    if (destCover) destCover.style.viewTransitionName = "";
  });
}

// ---------- data ----------

export async function refreshTapes() {
  const userId = state.user?.id;
  const token = getToken();
  const sameAccount = () => state.user?.id === userId && getToken() === token;
  try {
    const { tapes } = await api.listTapes();
    if (!sameAccount()) return false;
    state.tapes = tapes;
    state.loaded = true;
    state.loadError = "";
    return true;
  } catch (error) {
    if (!sameAccount()) return false;
    state.loadError = error.message;
    throw error;
  }
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
  const shell = app();

  if (!state.user) {
    renderAuth(shell);
    return;
  }

  shell.innerHTML = `${sidebar(state.view)}<div class="app-main">${workspaceHeader()}<main id="workspace" tabindex="-1"></main></div>`;
  const root = shell.querySelector("#workspace");

  switch (state.view) {
    case "library":
      renderLibrary(root);
      break;
    case "detail":
      renderDetail(root, state.viewArg);
      break;
    case "scouts":
      renderScouts(root);
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
    case "backup":
      renderBackup(root);
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
    default:
      renderLibrary(root);
  }

  shell.insertAdjacentHTML("beforeend", tabBar(state.view));
  wireNavigation(shell);
}

export function rerender() {
  render();
}

const NAV_ITEMS = [
  ["library", "library", "Collection"],
  ["scan", "camera", "Scan workspace"],
  ["scouts", "search", "Scout lists"],
  ["stats", "stats", "Insights"],
  ["sales", "sales", "Sales"],
];
function sidebar(active) {
  return `<aside class="sidebar">
    <a class="brand" href="/" aria-label="VHS Vault home">${brandMark()}<span>VHS<span class="brand-light">Vault</span><small>THE COLLECTOR’S COMPANION</small></span></a>
    <div class="sidebar-label">Workspace</div>
    <nav aria-label="Main navigation">${NAV_ITEMS.map(([view, icon, label]) => `<button type="button" class="side-link${active === view ? " active" : ""}" data-tab="${view}" ${active === view ? 'aria-current="page"' : ""}>${icons[icon]}<span>${label}</span>${view === "library" ? `<span class="nav-count">${state.tapes.length}</span>` : ""}</button>`).join("")}</nav>
    <div class="sidebar-note"><span class="mono">GOOD TAPES. GOOD COMPANY.</span><p>A little analog.<br>A lot more organized.</p><div class="color-stripes" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>
    <div class="sidebar-bottom"><button type="button" class="side-link${["settings", "backup"].includes(active) ? " active" : ""}" data-tab="settings">${icons.settings}<span>Account &amp; backup</span></button><div class="account"><span class="account-avatar">${esc((state.user?.email || "V")[0].toUpperCase())}</span><div><strong>${esc(state.user?.displayName || "Your personal vault")}</strong><p>${esc(state.user?.email || "")}</p></div></div></div>
  </aside>`;
}
function workspaceHeader() {
  const labels = {
    library: "Collection",
    scan: "Scan workspace",
    scouts: "Scout lists",
    stats: "Insights",
    sales: "Sales",
    settings: "Account & backup",
    backup: "Backup & import",
    detail: "Tape details",
    addTitle: "Add a title",
    bulk: "Paste a list",
    csv: "Import inventory",
  };
  return `<header class="workspace-header"><div class="breadcrumb"><span>Personal vault</span><span aria-hidden="true">/</span><strong>${labels[state.view] || "Collection"}</strong></div><div class="header-right"><span class="header-note">Made for the love of tape.</span><button type="button" class="icon-button" data-tab="settings" aria-label="Settings">${icons.settings}</button><button type="button" class="icon-button mobile-menu-toggle" data-menu aria-label="Open navigation" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></div></header>`;
}
function tabBar(active) {
  if (active === "backup") active = "settings";
  return `<nav class="mobile-tabs" aria-label="Mobile navigation">${[...NAV_ITEMS.filter(([view]) => view !== "sales"), ["settings", "settings", "Settings"]].map(([view, icon, label]) => `<button type="button" class="mobile-tab${active === view ? " active" : ""}" data-tab="${view}" ${active === view ? 'aria-current="page"' : ""}>${icons[icon]}<span>${view === "scan" ? "Scan" : view === "scouts" ? "Scouts" : label}</span></button>`).join("")}</nav>`;
}
function wireNavigation(root) {
  root.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (state.view !== btn.dataset.tab) go(btn.dataset.tab);
    }),
  );
  root.querySelector("[data-menu]")?.addEventListener("click", (event) => {
    const open = root.querySelector(".sidebar").classList.toggle("mobile-open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.setAttribute(
      "aria-label",
      open ? "Close navigation" : "Open navigation",
    );
  });
  root.querySelector(".brand")?.addEventListener("click", (event) => {
    event.preventDefault();
    go("library");
  });
}

// ---------- account sessions ----------

export function adoptAccountSession(result) {
  const marker = result.sessionId ? `cookie:${result.sessionId}` : result.token || getToken();
  if (!marker || !result.user?.id) throw new Error("Your sign-in could not be confirmed. Please try again.");
  if (marker !== getToken()) disposeScanSession();
  setToken(marker);
  state.user = result.user;
}

function renderAuth(root) {
  renderAuthView(root, async (result) => {
    adoptAccountSession(result);
    await loadAndEnter({ offerInstall: !result.recoveryCode });
  });
}

// ---------- boot ----------

async function loadAndEnter({ offerInstall = true } = {}) {
  try {
    if ((await refreshTapes()) === false) return;
  } catch (err) {
    toast(err.message, { error: true });
  }
  // Manifest shortcut ("Scan Tapes") and ?action=scan deep links.
  const action = new URLSearchParams(location.search).get("action");
  if (action === "scan") {
    history.replaceState({ view: "library" }, "", "/");
    go("scan");
    return;
  }
  go("library", null, { replace: true });
  // Offer Add-to-Home-Screen once things have settled (skips if installed,
  // recently dismissed, or the platform can't install).
  if (offerInstall) setTimeout(() => maybeOfferInstall(), 1600);
}

window.addEventListener("vhs:signed-out", () => {
  closeAllSheets();
  disposeBackup();
  disposeScanSession();
  state.user = null;
  state.tapes = [];
  state.loaded = false;
  state.loadError = "";
  state.view = "auth";
  render();
  toast("Signed out.", {});
});

// Another tab can change the shared session token while this tab has a draft.
// Stop the previous user's work before re-establishing the authenticated shell.
window.addEventListener("storage", (event) => {
  if (event.key === "vhsvault.token" && event.oldValue !== event.newValue) {
    closeAllSheets();
    disposeBackup();
    disposeScanSession();
    window.location.reload();
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    state.view === "library" &&
    !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") &&
    !document.querySelector(".sheet.open")
  ) {
    event.preventDefault();
    document.querySelector("[data-search]")?.focus();
  }
});

export function clearAccountSession() {
  closeAllSheets();
  disposeBackup();
  disposeScanSession();
  setToken(null);
  state.user = null;
  state.tapes = [];
  state.loaded = false;
  state.loadError = "";
  go("auth", null, { replace: true });
}

export async function signOut(options = { expectedToken: getToken() }) {
  // A local-only logout would leave the HttpOnly session active on this device.
  // Keep the account visible if the server cannot confirm session revocation.
  await api.logout(options);
  clearAccountSession();
}

async function boot() {
  const expectedToken = getToken();
  const hadSession = Boolean(expectedToken);
  try {
    const result = await api.me({ expectedToken });
    adoptAccountSession(result);
    await loadAndEnter();
    return;
  } catch (err) {
    if (getToken() !== expectedToken && getToken() !== null) return;
    if (err.status === 401) setToken(null);
    else if (hadSession) { renderOffline(err); return; }
  }
  state.view = "auth";
  history.replaceState({ view: "auth" }, "");
  render();
}

function renderOffline(err) {
  app().innerHTML = `
    <div class="auth-screen fade-in">
      <div class="auth-logo">
        <div class="logo-mark">${brandMark()}</div>
        <h1>VHS Vault</h1>
        <p>${esc(err?.status === 0 ? "You appear to be offline." : "Couldn't reach the server.")}</p>
      </div>
      <button class="btn mt-16" data-retry>Try Again</button>
    </div>`;
  app()
    .querySelector("[data-retry]")
    .addEventListener("click", () => {
      app().querySelector("[data-retry]").innerHTML =
        `<span class="spinner"></span>`;
      boot();
    });
}

initInstall();
boot();
