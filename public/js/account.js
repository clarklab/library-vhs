import { api, getToken } from "./api.js";
import { state, go, signOut, upsertTapes, adoptAccountSession, clearAccountSession } from "./app.js";
import { icons } from "./icons.js";
import { esc } from "./util.js";
import { openSheet, toast } from "./ui.js";
import { passwordField, wirePasswordVisibility, showRecoveryCode } from "./auth-view.js";
import { maybeOfferInstall, isStandalone } from "./install.js";

export function renderSettings(root) {
  const user = state.user;
  const token = getToken();
  const controller = new AbortController();
  const options = { expectedToken: token, signal: controller.signal };
  const current = () => root.isConnected && state.view === "settings" && state.user?.id === user.id && getToken() === token;
  const observer = new MutationObserver(() => { if (!current()) { controller.abort(); observer.disconnect(); } });
  observer.observe(document.getElementById("app"), { childList: true, subtree: true });
  const joined = user.createdAt && !Number.isNaN(Date.parse(user.createdAt)) ? new Date(user.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";
  root.innerHTML = `<div class="screen account-screen">
    <header class="account-heading"><div><p class="eyebrow">YOUR VAULT. YOUR DATA.</p><h1>Account &amp; backup<span class="accent-dot">.</span></h1><p>A simple home for your details, sign-in and saved collection.</p></div><button type="button" class="btn gray" data-account-signout>${icons.logout} Sign out</button></header>
    <div class="account-grid">
      <section class="settings-card" aria-labelledby="profile-heading"><div class="account-profile"><span class="account-avatar large">${esc((user.displayName || user.email || "V")[0].toUpperCase())}</span><div><h2 id="profile-heading">Your account</h2><p>${esc(user.email)}</p>${joined ? `<small>Collecting since ${esc(joined)}</small>` : ""}</div></div><form class="account-form" data-profile-form><label for="account-name">Name <span class="optional">optional</span></label><input class="text-field" id="account-name" name="displayName" autocomplete="nickname" maxlength="80" placeholder="What should we call you?" value="${esc(user.displayName || "")}" /><p class="hint">Your email address is your sign-in name.</p><div class="account-actions"><button class="btn gray" type="submit">Save name</button><span data-profile-status role="status"></span></div></form></section>
      <section class="settings-card account-backup-card" aria-labelledby="backup-heading"><p class="eyebrow">A COPY YOU CAN KEEP</p><h2 id="backup-heading">Take your collection<br>with you.</h2><p>Download a restorable backup, work in a spreadsheet, or bring a collection into your vault.</p><div class="backup-format-labels"><span>Full backup</span><span>CSV</span><span>Excel</span></div><button type="button" class="btn" data-account-backup>${icons.export} Backup &amp; import</button><p class="hint">Saved tapes, scout lists and uploaded covers are stored online. Unfinished scan photos stay on the device where you captured them.</p></section>
      <section class="settings-card account-security" aria-labelledby="security-heading"><p class="eyebrow">KEEP THE KEY TO YOUR VAULT</p><h2 id="security-heading">Sign-in &amp; recovery</h2><div class="account-security-list"><div><div><strong>Password</strong><p>Choose a new password and sign out other sessions.</p></div><button type="button" class="btn gray" data-change-password>Change password</button></div><div><div><strong>Recovery key</strong><p>${user.hasRecoveryCode ? "You have a recovery key. Replace it if you no longer have your copy." : "Save a key now so you can reset a forgotten password."}</p></div><button type="button" class="btn gray" data-recovery-key>${user.hasRecoveryCode ? "Replace recovery key" : "Create recovery key"}</button></div><div><div><strong>Signed in elsewhere?</strong><p>End all sessions, including this one.</p></div><button type="button" class="btn gray" data-logout-all>Sign out everywhere</button></div></div></section>
      <section class="settings-card account-app"><p class="eyebrow">READY WHEN YOU ARE</p><h2>On your home screen</h2><p>Keep your vault a tap away when you’re browsing the shelves.</p><button type="button" class="btn gray" data-install>${isStandalone() ? "App installed" : "Add to home screen"}</button><p class="hint">Sign in with the same account on another device to see your saved collection.</p></section>
    </div>
    <details class="account-advanced"><summary>Movie details &amp; optional settings</summary><div class="settings-card"><div class="account-detail-heading"><div><h2>Posters &amp; movie details</h2><p data-omdb-status>Checking connection…</p></div><button type="button" class="btn gray" data-refresh-all>Fill in missing details</button></div><p class="hint">Looks up missing posters, ratings and credits. Fields you already filled in are kept.</p><p data-refresh-status role="status"></p><form class="account-form" data-key-form><label for="account-omdb">Personal OMDb key <span class="optional">optional</span></label><input id="account-omdb" name="omdbKey" class="text-field" type="password" autocomplete="off" autocapitalize="off" placeholder="${user.settings?.hasOmdbKey ? "Key saved. Leave blank to remove." : "Only needed without a shared site key"}" /><button class="btn gray" type="submit">Save key</button><p data-key-status role="status"></p></form></div></details>
    <p class="account-footer">VHS Vault · Be kind, rewind.</p></div>`;
  root.querySelector("[data-account-backup]").onclick = () => go("backup");
  root.querySelector("[data-install]").onclick = () => maybeOfferInstall({ manual: true });
  root.querySelector("[data-account-signout]").onclick = async (event) => {
    if (!current()) return;
    const button = event.currentTarget;
    button.disabled = true;
    try { await signOut(options); } catch (error) { if (current()) { button.disabled = false; toast("Couldn’t sign out yet. " + error.message, { error: true }); } }
  };
  root.querySelector("[data-profile-form]").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    const status = root.querySelector("[data-profile-status]");
    status.textContent = "Saving…";
    try {
      const { user: updated } = await api.updateProfile(form.elements.displayName.value.trim(), options);
      if (!current()) return;
      state.user = updated;
      status.textContent = "Name saved.";
      const sidebarName = document.querySelector(".sidebar .account strong");
      if (sidebarName) sidebarName.textContent = updated.displayName || "Your personal vault";
    } catch (error) { if (current()) status.textContent = error.message; }
    finally { if (current()) button.disabled = false; }
  };

  function passwordAction(kind) {
    const changing = kind === "password";
    const recovering = kind === "recovery";
    const title = changing ? "Change password" : recovering ? "Create a recovery key" : "Sign out everywhere";
    const intro = changing ? "Use a new password with at least 12 characters. Other sessions will be signed out."
      : recovering ? "Confirm your password to create a new recovery key. Any previous key will stop working."
      : "Confirm your password to sign out all devices, including this one. Your saved collection stays in your account.";
    const { body, close } = openSheet({ title, content: `<form class="account-form" data-account-password-form><p>${intro}</p>${passwordField({ id: "account-current-password", label: "Current password", name: "currentPassword" })}${changing ? passwordField({ id: "account-new-password", label: "New password", name: "newPassword", fresh: true }) : ""}<p class="auth-error" data-account-form-error role="alert"></p><button class="btn" type="submit">${changing ? "Save new password" : recovering ? "Create recovery key" : "Sign out everywhere"}</button></form>` });
    wirePasswordVisibility(body);
    body.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!current() || !form.reportValidity()) return;
      const button = form.querySelector("button[type=submit]");
      if (button.disabled) return;
      button.disabled = true;
      const error = body.querySelector("[data-account-form-error]");
      error.textContent = "";
      try {
        const password = form.elements.currentPassword.value;
        if (changing) {
          const result = await api.changePassword(password, form.elements.newPassword.value, options);
          if (!current()) return;
          adoptAccountSession(result);
          close();
          go("settings", null, { replace: true });
          toast("Password changed. Other sessions are signed out.");
        } else if (recovering) {
          const result = await api.recoveryCode(password, options);
          if (!current()) return;
          state.user = result.user;
          close();
          go("settings", null, { replace: true });
          setTimeout(() => { if (state.user?.id === user.id && getToken() === token) showRecoveryCode({ code: result.recoveryCode, email: user.email }); }, 340);
        } else {
          await api.logoutAll(password, options);
          if (!current()) return;
          close();
          clearAccountSession();
          toast("All sessions signed out.");
        }
        form.reset();
      } catch (err) { if (form.isConnected) error.textContent = err.message; }
      finally { if (form.isConnected) button.disabled = false; }
    };
  }
  root.querySelector("[data-change-password]").onclick = () => passwordAction("password");
  root.querySelector("[data-recovery-key]").onclick = () => passwordAction("recovery");
  root.querySelector("[data-logout-all]").onclick = () => passwordAction("logout");

  const status = root.querySelector("[data-omdb-status]");
  api.getSettings(options).then(({ settings }) => {
    if (current()) status.textContent = settings.omdbActive ? `Connected ${settings.hasOmdbKey ? "with your key" : "with the site key"}` : "AI movie lookup available";
  }).catch(() => { if (current()) status.textContent = "Connection unavailable"; });
  root.querySelector("[data-key-form]").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const key = form.elements.omdbKey.value.trim();
      await api.saveSettings({ omdbKey: key }, options);
      if (!current()) return;
      state.user.settings = { ...state.user.settings, hasOmdbKey: Boolean(key) };
      form.reset();
      root.querySelector("[data-key-status]").textContent = key ? "Key saved." : "Personal key removed.";
      const { settings } = await api.getSettings(options);
      if (current()) status.textContent = settings.omdbActive ? "Connected" : "AI movie lookup available";
    } catch (error) { if (current()) root.querySelector("[data-key-status]").textContent = error.message; }
    finally { if (current()) button.disabled = false; }
  };
  root.querySelector("[data-refresh-all]").onclick = async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    const message = root.querySelector("[data-refresh-status]");
    const targets = state.tapes.filter((tape) => !tape.posterUrl || !tape.director || !tape.year || !tape.plot || !tape.imdbRating);
    let done = 0;
    try {
      for (let offset = 0; offset < targets.length && current(); offset += 25) {
        const chunk = targets.slice(offset, offset + 25);
        message.textContent = `Looking up ${Math.min(offset + 25, targets.length)} of ${targets.length} tapes…`;
        const { results } = await api.enrich(chunk.map(({ title, year }) => ({ title, year })), options);
        if (!current()) return;
        for (let i = 0; i < chunk.length && current(); i++) {
          const tape = state.tapes.find((item) => item.id === chunk[i].id);
          const hit = results?.[i];
          if (!tape || !hit?.matched) continue;
          const patch = {};
          for (const field of ["posterUrl", "year", "director", "genre", "runtime", "rated", "plot", "imdbRating", "imdbId"]) if (!tape[field] && hit[field]) patch[field] = hit[field];
          if (!tape.actors?.length && hit.actors?.length) patch.actors = hit.actors;
          if (!Object.keys(patch).length) continue;
          const result = await api.updateTape(tape.id, patch, options);
          if (!current()) return;
          upsertTapes([result.tape]);
          done++;
        }
      }
      if (current()) message.textContent = done ? `Updated ${done} tapes.` : "Your collection is already up to date.";
    } catch (error) { if (current()) message.textContent = `${done} updated. ${error.message}`; }
    finally { if (current()) button.disabled = false; }
  };
}
