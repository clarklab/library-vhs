import { api, getToken } from "./api.js";
import { brandMark, cassetteArt } from "./brand.js";
import { icons } from "./icons.js";
import { esc, downloadFile } from "./util.js";
import { openSheet, toast } from "./ui.js";

export function wirePasswordVisibility(root) {
  root.querySelectorAll("[data-show-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = root.querySelector(`#${CSS.escape(button.dataset.showPassword)}`);
      const showing = input.type === "password";
      input.type = showing ? "text" : "password";
      button.textContent = showing ? "Hide" : "Show";
      button.setAttribute("aria-pressed", String(showing));
      button.setAttribute("aria-label", `${showing ? "Hide" : "Show"} password`);
    });
  });
}

export function passwordField({ id, label, name = "password", fresh = false }) {
  return `<label for="${id}">${label}</label><div class="password-control"><input id="${id}" class="text-field" type="password" name="${name}" autocomplete="${fresh ? "new-password" : "current-password"}" maxlength="${fresh ? 128 : 1024}" ${fresh ? 'minlength="12"' : ""} required /><button type="button" class="password-toggle" data-show-password="${id}" aria-pressed="false" aria-label="Show password">Show</button></div>`;
}

export function showRecoveryCode({ code, email }) {
  const { body, close } = openSheet({
    title: "Save your recovery key",
    content: `<div class="recovery-content"><p>Use this key to get back into your account if you forget your password.</p><label for="recovery-key">Your recovery key</label><textarea id="recovery-key" name="recoveryKey" class="recovery-key" readonly spellcheck="false">${esc(code)}</textarea><p class="hint">Keep it in your password manager or somewhere private. It can reset your password and is shown only once.</p><div class="account-actions"><button type="button" class="btn" data-download-recovery>${icons.export} Download key</button><button type="button" class="btn gray" data-copy-recovery>Copy key</button></div><p data-recovery-feedback role="status"></p><button type="button" class="btn gray" data-recovery-done>Done</button></div>`,
  });
  body.querySelector("[data-copy-recovery]").onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      body.querySelector("[data-recovery-feedback]").textContent = "Key copied. Save it somewhere private.";
    } catch {
      body.querySelector("textarea").select();
      body.querySelector("[data-recovery-feedback]").textContent = "Select and copy the key above.";
    }
  };
  body.querySelector("[data-download-recovery]").onclick = () => {
    downloadFile("vhs-vault-recovery-key.txt", `VHS Vault account recovery\n\nEmail: ${email}\nRecovery key: ${code}\n\nKeep this file private. On the sign-in screen, choose Forgot password, then use this key. Each key can be used once. A replacement key invalidates this one.\n`);
    body.querySelector("[data-recovery-feedback]").textContent = "Download started. Keep this file somewhere private.";
  };
  body.querySelector("[data-recovery-done]").onclick = close;
}

export function renderAuth(root, onAuthenticated) {
  const expectedToken = getToken();
  let mode = "login";
  let busy = false;
  root.innerHTML = `<main id="workspace" class="auth-layout">
    <section class="auth-story"><a href="/" class="brand" aria-label="VHS Vault home">${brandMark()}<span>VHS<span class="brand-light">Vault</span></span></a><div class="auth-story-copy"><p class="eyebrow">ANALOG OBSESSION. DIGITAL PRECISION.</p><h1>A home for<br>every tape.</h1><p>From a weekend find to a wall of classics.<br>Keep your collection in the picture.</p></div><div class="auth-art">${cassetteArt()}</div><div class="auth-caption"><span>REWIND. REDISCOVER. REPEAT.</span><span>VHS / HI-FI</span></div></section>
    <section class="auth-panel"><div class="auth-content"><p class="eyebrow">YOUR PERSONAL ARCHIVE</p><h2 data-auth-title>Welcome to the vault.</h2><p class="auth-intro" data-auth-intro>Your collection, wherever you sign in.</p><div class="segmented auth-modes" role="group" aria-label="Account action"><button type="button" class="active" data-mode="login" aria-pressed="true">Sign in</button><button type="button" data-mode="signup" aria-pressed="false">Create account</button></div>
    <form class="auth-form" data-auth-form><label for="auth-email">Email address</label><input id="auth-email" class="text-field" type="email" name="email" placeholder="you@example.com" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254" required />
    <div class="auth-recovery-field" data-recovery-field hidden><label for="auth-recovery">Recovery key</label><input id="auth-recovery" class="text-field" name="recoveryCode" type="text" placeholder="Your saved recovery key" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="100" /></div>
    <div data-auth-password>${passwordField({ id: "auth-password", label: "Password" })}</div><p class="password-help" data-password-help hidden>Use at least 12 characters. A few words works well.</p><div class="auth-error" data-auth-error role="alert"></div><button class="btn" type="submit" data-auth-submit>Sign in ${icons.chevronRight}</button></form>
    <button type="button" class="auth-forgot" data-forgot>Forgot password?</button><button type="button" class="auth-forgot" data-back-signin hidden>Back to sign in</button><p class="auth-recovery-explanation" data-recovery-explanation hidden>Use the recovery key saved when you created your account or from Account settings. A collection backup can restore your tapes into a new account if you no longer have the key.</p><div class="auth-footnote">${icons.camera}<p>Photograph a shelf. Review the finds.<br>Keep a backup you can take with you.</p></div></div><p class="auth-bottom mono">BUILT FOR COLLECTORS. EVERY LAST COPY.</p></section></main>`;
  const form = root.querySelector("form");
  const error = root.querySelector("[data-auth-error]");
  const submit = root.querySelector("[data-auth-submit]");
  const email = form.elements.email;
  function selectMode(next) {
    if (busy) return;
    mode = next;
    const reset = mode === "reset";
    const signup = mode === "signup";
    root.querySelector("[data-auth-title]").textContent = reset ? "Find your way back." : signup ? "Make room for your collection." : "Welcome to the vault.";
    root.querySelector("[data-auth-intro]").textContent = reset ? "A recovery key and a fresh password." : signup ? "Just your email and a password to get started." : "Your collection, wherever you sign in.";
    root.querySelector(".auth-modes").hidden = reset;
    root.querySelectorAll("[data-mode]").forEach((button) => { button.classList.toggle("active", button.dataset.mode === mode); button.setAttribute("aria-pressed", String(button.dataset.mode === mode)); });
    root.querySelector("[data-recovery-field]").hidden = !reset;
    form.elements.recoveryCode.required = reset;
    root.querySelector("[data-auth-password]").innerHTML = passwordField({ id: "auth-password", label: reset ? "New password" : "Password", fresh: signup || reset });
    root.querySelector("[data-password-help]").hidden = mode === "login";
    root.querySelector("[data-forgot]").hidden = reset;
    root.querySelector("[data-back-signin]").hidden = !reset;
    root.querySelector("[data-recovery-explanation]").hidden = !reset;
    submit.textContent = reset ? "Reset password & sign in" : signup ? "Create account" : "Sign in";
    error.textContent = "";
    wirePasswordVisibility(root.querySelector("[data-auth-password]"));
  }
  wirePasswordVisibility(root);
  root.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => selectMode(button.dataset.mode));
  root.querySelector("[data-forgot]").onclick = () => selectMode("reset");
  root.querySelector("[data-back-signin]").onclick = () => selectMode("login");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    error.textContent = "";
    const label = submit.textContent;
    root.querySelectorAll("button").forEach((button) => button.disabled = true);
    submit.innerHTML = '<span class="spinner"></span> Opening your vault…';
    try {
      const result = mode === "reset" ? await api.resetPassword(email.value.trim(), form.elements.recoveryCode.value.trim(), form.elements.password.value, { expectedToken })
        : mode === "signup" ? await api.signup(email.value.trim(), form.elements.password.value, { expectedToken }) : await api.login(email.value.trim(), form.elements.password.value, { expectedToken });
      if (!form.isConnected) return;
      form.elements.password.value = "";
      form.elements.recoveryCode.value = "";
      await onAuthenticated(result);
      if (result.recoveryCode && getToken() === `cookie:${result.sessionId}`) showRecoveryCode({ code: result.recoveryCode, email: result.user.email });
    } catch (err) {
      if (form.isConnected) error.textContent = err.message;
      else toast(err.message, { error: true });
    } finally {
      busy = false;
      if (form.isConnected) { root.querySelectorAll("button").forEach((button) => button.disabled = false); submit.textContent = label; }
    }
  });
}
