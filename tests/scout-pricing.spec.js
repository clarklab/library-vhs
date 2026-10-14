import { test, expect } from "@playwright/test";

async function scoutingFixture(page, { count = 40, delay = 20, failOnce = null, unknownFirst = false } = {}) {
  let list = {
    id: "s_test", name: "Whole shelf", photos: [{ id: "photo-1", name: "Shelf" }], updatedAt: new Date().toISOString(),
    items: Array.from({ length: count }, (_, i) => ({ clientId: `item-${i}`, title: `Film ${i + 1}`, format: "VHS", photoId: "photo-1", sourceIndex: i + 1, estimate: null })),
  };
  if (unknownFirst) Object.assign(list.items[0], { title: "Unknown", format: "Other" });
  const calls = [];
  const patches = [];
  const errors = [];
  let active = 0;
  let peak = 0;
  let failed = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("vhsvault.token", "pricing-test-session");
    localStorage.setItem("vhsvault.installDismissedAt", String(Date.now()));
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postDataJSON();
    const send = async (data, status = 200) => {
      try { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) }); }
      catch { /* A paused lookup may already have been aborted by the browser. */ }
    };
    if (path === "/api/auth/me") return send({ user: { id: "pricing-user", email: "test@example.com" } });
    if (path === "/api/tapes") return send({ tapes: [] });
    if (path === "/api/settings") return send({ settings: {}, hasOmdbKey: false });
    if (path === "/api/scouts") return send({ lists: [{ ...list, itemCount: list.items.length, photoCount: 1, purchasedCount: 0, worthCheckingCount: 0 }] });
    if (path === "/api/scouts/s_other") return send({ list: { ...list, id: "s_other", name: "Another visit", items: [{ ...list.items[0], clientId: "other-item", title: "Another tape" }] } });
    if (path === "/api/scouts/s_test") {
      if (req.method() === "PATCH") {
        const subject = (item) => JSON.stringify([item.title, item.year ?? null, item.format, item.edition || "", item.artist || ""]);
        if (body.items.some((update) => update.estimate && subject(update.estimateFor) !== subject(list.items.find((item) => item.clientId === update.clientId)))) {
          return send({ error: "This find changed while its estimate was being prepared." }, 409);
        }
        patches.push(structuredClone(body.items));
        list = { ...list, items: list.items.map((item) => {
          const patch = body.items.find((update) => update.clientId === item.clientId);
          const changed = ["title", "year", "format", "edition", "artist"].some((field) => patch && Object.hasOwn(patch, field) && patch[field] !== item[field]);
          return { ...item, ...patch, ...(changed ? { estimate: null } : {}) };
        }) };
      }
      return send({ list });
    }
    if (path === "/api/value") {
      calls.push(body.clientId);
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, typeof delay === "function" ? delay(calls.length) : delay));
      active--;
      if (body.clientId === failOnce && !failed) { failed = true; return send({ error: "Try again after a pause.", retryable: true }, 429); }
      return send({ known: true, low: 15, high: 30, typical: 22, worthChecking: true, factors: [], summary: "AI estimate for testing.", estimatedAt: new Date().toISOString() });
    }
    return send({});
  });
  await page.goto("/");
  await page.locator(".sidebar [data-tab=scouts]").click();
  await page.locator("[data-open]").click();
  await expect(page.locator(".scout-item")).toHaveCount(Math.min(count, 40));
  return {
    calls, patches, errors, getList: () => list, getPeak: () => peak,
    changeItem: (id, patch) => { list = { ...list, items: list.items.map((item) => item.clientId === id ? { ...item, ...patch } : item) }; },
  };
}

test("40 selected scout estimates save progressively with only two lookups active", async ({ page }) => {
  const fixture = await scoutingFixture(page);
  await page.locator("[data-select]").click();
  await expect(page.locator("[data-selected]")).toHaveText("40 selected");
  await expect(page.locator("[data-estimate]")).toBeEnabled();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.patches.length).toBeGreaterThan(0);
  expect(fixture.calls.length).toBeLessThan(40);
  await expect(page.locator("[data-status]")).toContainText("40 of 40 estimates saved.");
  await expect(page.locator("[data-selected]")).toHaveText("0 selected");
  expect(fixture.calls).toHaveLength(40);
  expect(fixture.getPeak()).toBe(2);
  expect(fixture.patches).toHaveLength(20);
  expect(fixture.patches.every((patch) => patch.length === 2)).toBe(true);
  expect(fixture.getList().items.every((item) => item.estimate?.known)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("pausing retains confirmed estimates and retry processes only remaining selections", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 6, delay: (n) => n <= 2 ? 20 : 300 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.calls.length).toBe(4);
  await page.locator("[data-stop-estimates]").click();
  await expect(page.locator("[data-status]")).toContainText("Paused. 2 of 6 estimates saved.");
  await expect(page.locator("[data-selected]")).toHaveText("4 selected");
  await page.waitForTimeout(350);
  expect(fixture.calls).toHaveLength(4);
  expect(fixture.getList().items.filter((item) => item.estimate)).toHaveLength(2);
  await page.locator("[data-estimate]").click();
  await expect(page.locator("[data-status]")).toContainText("4 of 4 estimates saved.");
  expect(fixture.calls.filter((id) => id === "item-0")).toHaveLength(1);
  expect(fixture.calls.filter((id) => id === "item-1")).toHaveLength(1);
  expect(fixture.getList().items.every((item) => item.estimate)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("leaving the scout view aborts lookups and never starts the rest of a paid queue", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 6, delay: (n) => n <= 2 ? 20 : 300 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.calls.length).toBe(4);
  await page.locator(".sidebar [data-tab=library]").click();
  await page.waitForTimeout(350);
  expect(fixture.calls).toHaveLength(4);
  expect(fixture.patches).toHaveLength(1);
  expect(fixture.getList().items.filter((item) => item.estimate)).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
});

test("a rate limit stops the queue and keeps failed or unprocessed selections for retry", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 6, failOnce: "item-0", delay: 50 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect(page.locator("[data-status]")).toContainText("Paused.");
  expect(fixture.calls).toHaveLength(2);
  await expect(page.locator("[data-estimate]")).toBeEnabled();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.getList().items.filter((item) => item.estimate).length).toBe(6);
  await expect(page.locator("[data-selected]")).toHaveText("0 selected");
  expect(fixture.errors).toEqual([]);
});

test("an edited Unknown scout find becomes priceable without changing its physical identity", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 1, unknownFirst: true });
  await expect(page.locator("[data-estimate-item]")).toBeDisabled();
  await expect(page.locator("[data-purchase-item]")).toBeDisabled();
  await page.locator("[data-edit-item]").click();
  const form = page.locator("[data-edit-scout-form]");
  await form.locator("[name=title]").fill("Jaws");
  await form.locator("[name=format]").selectOption("VHS");
  await form.locator("[name=year]").fill("1975");
  await form.locator("[name=edition]").fill("Universal release");
  await form.locator("[type=submit]").click();
  await expect(page.locator(".scout-item h3")).toContainText("Jaws");
  await expect(page.locator("[data-estimate-item]")).toBeEnabled();
  await expect(page.locator("[data-purchase-item]")).toBeEnabled();
  expect(fixture.getList().items[0].clientId).toBe("item-0");
  expect(fixture.getList().items[0].photoId).toBe("photo-1");
  await page.locator("[data-estimate-item]").click();
  await expect(page.locator(".scout-check-label")).toHaveCount(1);
  await page.locator("[data-edit-item]").click();
  await form.locator("[name=edition]").fill("Different printing");
  await form.locator("[type=submit]").click();
  await expect(page.locator(".scout-item-value strong")).toHaveText("Not checked");
  expect(fixture.getList().items[0].estimate).toBeNull();
  expect(fixture.errors).toEqual([]);
});

test("changing scout detail within the same workspace prevents stale work from repainting or continuing", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 6, delay: 300 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.calls.length).toBe(2);
  await page.evaluate(async () => {
    const { state } = await import("/js/app.js");
    const { renderScouts } = await import("/js/scouts.js");
    state.viewArg = "s_other";
    await renderScouts(document.querySelector("#workspace"));
  });
  await expect(page.locator("[data-title]")).toHaveText("Another visit");
  await page.waitForTimeout(350);
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.patches).toHaveLength(0);
  await expect(page.locator("[data-title]")).toHaveText("Another visit");
  expect(fixture.errors).toEqual([]);
});

test("a bearer-token change cannot persist old-account pricing before the sign-out event renders", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 6, delay: 300 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.calls.length).toBe(2);
  await page.evaluate(() => localStorage.setItem("vhsvault.token", "another-account-token"));
  await page.waitForTimeout(350);
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.patches).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test("a find corrected elsewhere while pricing is refreshed before a safe retry", async ({ page }) => {
  const fixture = await scoutingFixture(page, { count: 2, delay: 150 });
  await page.locator("[data-select]").click();
  await page.locator("[data-estimate]").click();
  await expect.poll(() => fixture.calls.length).toBe(2);
  fixture.changeItem("item-0", { title: "Corrected title" });
  await expect(page.locator("[data-status]")).toContainText("The list is refreshed");
  await expect(page.locator(".scout-item h3").first()).toHaveText("Corrected title");
  expect(fixture.getList().items.every((item) => !item.estimate)).toBe(true);
  await expect(page.locator("[data-selected]")).toHaveText("2 selected");
  await page.locator("[data-estimate]").click();
  await expect(page.locator("[data-status]")).toContainText("2 of 2 estimates saved.");
  expect(fixture.calls).toHaveLength(4);
  expect(fixture.getList().items.every((item) => item.estimate?.known)).toBe(true);
  expect(fixture.errors).toEqual([]);
});
