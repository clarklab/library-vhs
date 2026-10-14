import { test, expect } from "@playwright/test";
const titles = [
  "Jurassic Park",
  "Jaws",
  "The Lost Boys",
  "Blade Runner",
  "Beetlejuice",
  "The Thing",
  "Alien",
  "Back to the Future",
  "The Goonies",
  "Ghostbusters",
  "The Terminator",
  "E.T.",
];
const library = titles.map((title, index) => ({
  id: `t-${index}`,
  title,
  year: 1980 + index,
  genre: ["Horror", "Science fiction", "Adventure"][index % 3],
  status: index % 3 === 0 ? "available" : "keep",
  priceAsking: 5 + index,
  format: "VHS",
  createdAt: `2026-10-${String(14 - index).padStart(2, "0")}`,
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const mockImage = { name: "shelf.png", mimeType: "image/png", buffer: png };
async function setup(page, { empty = false, itemsPerPhoto = 2 } = {}) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("vhsvault.token", "test-session");
    localStorage.setItem("vhsvault.installDismissedAt", String(Date.now()));
  });
  let tapes = empty ? [] : structuredClone(library);
  let scout = null;
  let scans = 0;
  let creates = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    const send = (data) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (path === "/api/auth/me")
      return send({ user: { id: "qa-user", email: "collector@example.com" } });
    if (path === "/api/tapes") {
      if (request.method() === "GET") return send({ tapes });
      creates++;
      const result = body.tapes.map((t) => ({
        ...t,
        id: `saved-${t.clientId}`,
      }));
      tapes.push(...result);
      return send({ tapes: result, failedCount: 0 });
    }
    if (path === "/api/settings")
      return send({ settings: {}, hasOmdbKey: false });
    if (path === "/api/scouts") {
      if (request.method() === "GET")
        return send({
          lists: scout
            ? [
                {
                  ...scout,
                  itemCount: scout.items.length,
                  photoCount: scout.photos.length,
                  purchasedCount: 0,
                  worthCheckingCount: 0,
                },
              ]
            : [],
        });
      scout = { ...body, id: "s_test", updatedAt: new Date().toISOString() };
      return send({ list: scout });
    }
    if (path === "/api/scouts/s_test") {
      if (request.method() === "PATCH")
        scout = {
          ...scout,
          items: scout.items.map((item) => ({
            ...item,
            ...body.items?.find((i) => i.clientId === item.clientId),
          })),
        };
      return send({ list: scout });
    }
    if (path === "/api/scan") {
      scans++;
      await new Promise((r) => setTimeout(r, 80));
      if (itemsPerPhoto > 2) {
        return send({
          count: itemsPerPhoto,
          reportedCount: itemsPerPhoto,
          sourceId: body.sourceId,
          tapes: Array.from({ length: itemsPerPhoto }, (_, i) => ({
            title: `${titles[i % titles.length]} copy ${i + 1}`,
            format: "VHS",
            confidence: "high",
            needsReview: false,
            sourceIndex: i + 1,
          })),
          notes: "All visible tape spines read.",
          warnings: [],
          needsVerification: false,
          verification: {
            status: "matched",
            countedCount: itemsPerPhoto,
            listedCount: itemsPerPhoto,
            uncertainCount: 0,
            stage: "initial",
          },
        });
      }
      return send({
        count: 2,
        reportedCount: 2,
        sourceId: body.sourceId,
        tapes: [
          {
            title: "Jaws",
            format: "VHS",
            year: 1975,
            confidence: "high",
            needsReview: false,
            sourceIndex: 1,
          },
          {
            title: "Jurassic Park",
            format: "VHS",
            year: 1993,
            confidence: "medium",
            needsReview: true,
            sourceIndex: 2,
          },
        ],
        notes: "Two visible VHS boxes.",
        warnings: [],
        needsVerification: body.mode !== "thorough",
        verification: {
          status: "matched",
          countedCount: 2,
          listedCount: 2,
          uncertainCount: 1,
          stage: body.mode === "thorough" ? "reviewed" : "initial",
        },
      });
    }
    if (path === "/api/value")
      return send({
        known: true,
        low: 15,
        high: 30,
        typical: 22,
        worthChecking: true,
        summary: "Test estimate. Verify the exact edition.",
        factors: [],
        estimatedAt: new Date().toISOString(),
      });
    return send({ results: [] });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your collection." }),
  ).toBeVisible();
  return {
    errors,
    getScans: () => scans,
    getCreates: () => creates,
    getScout: () => scout,
  };
}
async function screenshot(page, name) {
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
}

test("ten photos and 300 titles stay paginated and save in safe batches", async ({
  page,
}) => {
  const app = await setup(page, { empty: true, itemsPerPhoto: 30 });
  await page.locator("[data-start-scan]").click();
  await page.locator("[data-file-library]").setInputFiles(
    Array.from({ length: 10 }, (_, i) => ({
      ...mockImage,
      name: `shelf-${i + 1}.png`,
    })),
  );
  await expect(page.locator("[data-run]")).toContainText("Read 10 photos");
  await page.locator("[data-run]").click();
  await expect(page.locator("[data-run]")).toContainText("All photos read");
  await expect(page.locator(".scan-item")).toHaveCount(50);
  await expect(page.locator("[data-save]")).toBeEnabled();
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-save-summary]")).toHaveText(
    "300 titles added to your collection",
  );
  expect(app.getScans()).toBe(10);
  expect(app.getCreates()).toBe(3);
  expect(app.errors).toEqual([]);
});

test("desktop collection, search, layouts and navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1060 });
  const app = await setup(page);
  await expect(page.locator(".cover-cell")).toHaveCount(12);
  await screenshot(page, "collection-desktop");
  await page.keyboard.press("/");
  await expect(page.locator("[data-search]")).toBeFocused();
  await page.locator("[data-search]").fill("Jurassic");
  await expect(page.locator(".cover-cell")).toHaveCount(1);
  await page.locator("[data-search]").fill("");
  await expect(page.locator(".cover-cell")).toHaveCount(12);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".tape-row")).toHaveCount(12);
  await page.getByRole("button", { name: "Spreadsheet view" }).click();
  await expect(page.locator(".sheet-table tbody tr")).toHaveCount(12);
  await page.locator(".sidebar [data-tab=scouts]").click();
  await expect(
    page.getByRole("heading", { name: "Your scout lists." }),
  ).toBeVisible();
  expect(app.errors).toEqual([]);
});

test("a late inventory response cannot replace a different account's collection", async ({
  page,
}) => {
  const app = await setup(page);
  let release;
  let started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/tapes", async (route) => {
    started();
    await held;
    await route.fulfill({
      json: { tapes: [{ id: "old-account-tape", title: "Old collection" }] },
    });
  });
  await page.evaluate(async () => {
    const app = await import("/js/app.js");
    window.pendingRefresh = app.refreshTapes();
  });
  await requested;
  await page.evaluate(async () => {
    const { state } = await import("/js/app.js");
    localStorage.setItem("vhsvault.token", "different-session");
    state.user = { id: "different-user", email: "different@example.com" };
    state.tapes = [
      { id: "different-account-tape", title: "Different collection" },
    ];
  });
  release();
  await page.evaluate(() => window.pendingRefresh);
  expect(
    await page.evaluate(async () =>
      (await import("/js/app.js")).state.tapes.map((t) => t.id),
    ),
  ).toEqual(["different-account-tape"]);
  expect(app.errors).toEqual([]);
});

test("batch review persists edits, gates uncertainty, saves scouts separately and prices/purchases a find", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1060 });
  const app = await setup(page);
  await page.locator("[data-start-scan]").click();
  await expect(page.locator("[data-file-library]")).toBeAttached();
  await screenshot(page, "scan-empty-desktop");
  await page.locator("[data-destination=scout]").click();
  await page.locator("[data-scout-name]").fill("Saturday store visit");
  await page
    .locator("[data-file-library]")
    .setInputFiles([mockImage, { ...mockImage, name: "shelf-2.png" }]);
  await expect(page.locator("[data-run]")).toContainText("Read 2 photos");
  await page.locator("[data-run]").click();
  await expect(page.locator(".scan-item")).toHaveCount(4);
  await expect(page.locator("[data-run]")).toContainText("All photos read");
  await expect(page.locator("[data-save]")).toBeDisabled();
  await page.locator("[data-title]").first().fill("Jaws — checked edition");
  for (const checkbox of await page
    .locator("[data-confirm-wrap]:visible [data-confirm]")
    .all())
    await checkbox.check();
  for (const checkbox of await page.locator("[data-photo-confirm]").all())
    await checkbox.check();
  await screenshot(page, "scan-review-desktop");
  await page.waitForTimeout(350);
  await page.reload();
  await page.locator("[data-start-scan]").click();
  await expect(page.locator("[data-title]").first()).toHaveValue(
    "Jaws — checked edition",
  );
  await expect(page.locator("[data-scout-name]")).toHaveValue(
    "Saturday store visit",
  );
  await expect(page.locator("[data-save]")).toBeEnabled();
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-save-summary]")).toContainText(
    "saved to your scout list",
  );
  expect(app.getCreates()).toBe(0);
  expect(app.getScans()).toBe(4);
  expect(app.getScout().items).toHaveLength(4);
  await page.locator(".sidebar [data-tab=scouts]").click();
  await page.locator("[data-open]").click();
  await expect(page.locator(".scout-item")).toHaveCount(4);
  await page.locator("[data-estimate-item]").first().click();
  await expect(page.locator(".scout-check-label")).toHaveCount(1);
  await screenshot(page, "scout-detail-desktop");
  await page.locator("[data-purchase-item]").first().click();
  await expect(page.locator(".scout-collected")).toHaveCount(1);
  expect(app.getCreates()).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "scout-detail-mobile");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(app.errors).toEqual([]);
});

test("mobile layouts stay within viewport and permit camera/scout selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await setup(page);
  await screenshot(page, "collection-mobile");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator(".mobile-tabs [data-tab=scan]").click();
  await expect(page.locator("[data-camera]")).toBeVisible();
  await page.locator("[data-destination=scout]").click();
  await expect(page.locator("[data-scout-name]")).toBeVisible();
  await screenshot(page, "scan-mobile");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator("[data-file-library]").setInputFiles(mockImage);
  await page.locator("[data-run]").click();
  await expect(page.locator(".scan-item")).toHaveCount(2);
  await screenshot(page, "scan-review-mobile");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(app.errors).toEqual([]);
});

test("auth forms are labeled and responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await screenshot(page, "auth-mobile");
});
