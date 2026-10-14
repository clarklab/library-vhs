import { test, expect } from "@playwright/test";

const firstSession = "a".repeat(32), nextSession = "b".repeat(32);
const key = "VHS-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z1234";
async function accountApp(page, { signedIn = false, logoutFailure = false } = {}) {
  let user = { id: "account-test", email: "collector@example.com", displayName: "", createdAt: "2026-10-01T12:00:00.000Z", hasRecoveryCode: true, settings: {} };
  let sessionId = firstSession;
  const requests = [], errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("vhsvault.installDismissedAt", String(Date.now())));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname, body = req.postDataJSON();
    requests.push({ path, body, headers: req.headers() });
    const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/auth/me") return signedIn ? send({ user, sessionId }) : send({ error: "Not signed in" }, 401);
    if (["/api/auth/signup", "/api/auth/reset", "/api/auth/login"].includes(path)) {
      signedIn = true;
      return send({ user, sessionId, ...(path.endsWith("login") ? {} : { recoveryCode: key }) });
    }
    if (path === "/api/tapes") return send({ tapes: [] });
    if (path === "/api/settings") return send({ settings: { omdbActive: true } });
    if (path === "/api/auth/profile") { user = { ...user, displayName: body.displayName }; return send({ user }); }
    if (path === "/api/auth/password") {
      if (body.currentPassword === "incorrect") return send({ error: "Your current password is incorrect." }, 403);
      sessionId = nextSession;
      return send({ user, sessionId });
    }
    if (path === "/api/auth/recovery") return send({ user, recoveryCode: key });
    if (["/api/auth/logout", "/api/auth/logout-all"].includes(path)) {
      if (logoutFailure) return send({ error: "Connection unavailable" }, 503);
      signedIn = false; return send({ ok: true });
    }
    return send({ error: `Unmocked ${path}` }, 404);
  });
  await page.goto("/");
  return { requests, errors };
}
const openAccount = async (page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Account & backup." })).toBeVisible();
};

test("two-field signup opens the account and provides a private downloadable recovery key", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await accountApp(page);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByLabel("Email address").fill("collector@example.com");
  await page.getByLabel("Password", { exact: true }).fill("a longer pass phrase");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.locator("[data-auth-submit]").click();
  const dialog = page.getByRole("dialog", { name: "Save your recovery key" });
  await expect(dialog.getByLabel("Your recovery key")).toHaveValue(key);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/recovery-mobile.png", fullPage: true });
  expect(await page.evaluate(() => localStorage.getItem("vhsvault.token"))).toBe(`cookie:${firstSession}`);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download key" }).click();
  expect((await download).suggestedFilename()).toBe("vhs-vault-recovery-key.txt");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("[data-start-scan]")).toBeVisible();
  expect(app.requests.find((r) => r.path.endsWith("signup")).body).toEqual({ email: "collector@example.com", password: "a longer pass phrase" });
  expect(app.errors).toEqual([]);
});

test("forgot password uses the saved recovery key and returns a replacement", async ({ page }) => {
  const app = await accountApp(page);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email address").fill("collector@example.com");
  await page.getByLabel("Recovery key", { exact: true }).fill("old-recovery-key");
  await page.getByLabel("New password", { exact: true }).fill("a new longer pass phrase");
  await page.getByRole("button", { name: "Reset password & sign in" }).click();
  await expect(page.getByRole("dialog").getByLabel("Your recovery key")).toHaveValue(key);
  expect(app.requests.find((r) => r.path.endsWith("reset")).body).toEqual({ email: "collector@example.com", recoveryCode: "old-recovery-key", newPassword: "a new longer pass phrase" });
  expect(app.errors).toEqual([]);
});

test("cookie sign-in survives a missing local marker; profile and password changes stay in the account", async ({ page }) => {
  const app = await accountApp(page, { signedIn: true });
  await openAccount(page);
  await page.screenshot({ path: "test-results/account-desktop.png", fullPage: true });
  await page.getByLabel("Name optional").fill("Tape collector");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator("[data-profile-status]")).toHaveText("Name saved.");
  await expect(page.locator(".sidebar .account strong")).toHaveText("Tape collector");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change password" });
  await dialog.getByLabel("Current password", { exact: true }).fill("incorrect");
  await dialog.getByLabel("New password", { exact: true }).fill("another long pass phrase");
  await dialog.getByRole("button", { name: "Save new password" }).click();
  await expect(dialog.getByRole("alert")).toContainText("incorrect");
  await dialog.getByLabel("Current password", { exact: true }).fill("old pass phrase");
  await dialog.getByRole("button", { name: "Save new password" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("vhsvault.token"))).toBe(`cookie:${nextSession}`);
  expect(app.requests.filter((r) => r.path.endsWith("password")).every((r) => r.headers["x-vhs-session"] === firstSession)).toBe(true);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const logout = page.getByRole("dialog", { name: "Sign out everywhere" });
  await logout.getByLabel("Current password", { exact: true }).fill("another long pass phrase");
  await logout.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to the vault." })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("vhsvault.token"))).toBeNull();
  expect(app.errors).toEqual([]);
});

test("failed sign-out keeps the account accessible and offers a retry", async ({ page }) => {
  const app = await accountApp(page, { signedIn: true, logoutFailure: true });
  await openAccount(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#toast-root")).toContainText("Couldn’t sign out yet");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("vhsvault.token"))).toBe(`cookie:${firstSession}`);
  expect(app.errors).toEqual([]);
});

test("account and backup controls fit a phone and route imports to the new flow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await accountApp(page, { signedIn: true });
  await openAccount(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/account-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Backup & import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download full backup" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/backup-mobile.png", fullPage: true });
  expect(app.errors).toEqual([]);
});
