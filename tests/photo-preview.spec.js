import { test, expect } from "@playwright/test";

const shelf = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800"><rect width="1200" height="1800" fill="#d8d6c2"/>${Array.from({ length: 12 }, (_, index) => `<rect x="90" y="${80 + index * 135}" width="1020" height="115" rx="8" fill="${index % 2 ? "#ece8d7" : "#283730"}"/><text x="130" y="${155 + index * 135}" font-size="48" font-family="sans-serif" fill="${index % 2 ? "#283730" : "#ece8d7"}">VHS SHELF · TITLE ${String(index + 1).padStart(2, "0")}</text>`).join("")}</svg>`);

test("mobile source-photo review rotates, zooms, pans and fits without altering the scanned image", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  let uploadedImage;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("vhsvault.token", "photo-preview-test");
    localStorage.setItem("vhsvault.installDismissedAt", String(Date.now()));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response = {};
    if (path === "/api/auth/me") response = { user: { id: "photo-preview-user", email: "preview@example.com" } };
    if (path === "/api/tapes") response = { tapes: [] };
    if (path === "/api/scan") {
      uploadedImage = route.request().postDataJSON().image;
      response = {
        tapes: [{ title: "Test tape", format: "VHS", confidence: "high", needsReview: false, sourceIndex: 1 }],
        verification: { status: "matched", countedCount: 1, listedCount: 1, uncertainCount: 0 },
        needsVerification: false, warnings: [],
      };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto("/");
  await page.locator(".mobile-tabs [data-tab=scan]").click();
  await page.locator("[data-file-library]").setInputFiles({ name: "sideways-shelf.svg", mimeType: "image/svg+xml", buffer: shelf });
  await expect(page.locator("[data-preview]")).toBeEnabled();
  await page.locator("[data-preview]").click();
  const dialog = page.getByRole("dialog", { name: "Photo 1 · 0 titles" });
  const image = dialog.locator("[data-photo-image]");
  const viewport = dialog.locator("[data-photo-viewport]");
  const source = await image.getAttribute("src");
  await expect(dialog.getByRole("button", { name: "Zoom out photo", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Rotate photo right 90 degrees" }).click();
  await dialog.getByRole("button", { name: "Rotate photo right 90 degrees" }).click();
  await dialog.getByRole("button", { name: "Rotate photo left 90 degrees" }).click();
  await expect(image).toHaveAttribute("style", /rotate\(90deg\)/);
  for (let i = 0; i < 3; i++) await dialog.getByRole("button", { name: "Zoom in photo", exact: true }).click();
  await expect(dialog.locator("[data-photo-zoom]")).toHaveText("338%");
  expect(await viewport.evaluate((element) => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight)).toBe(true);
  await viewport.focus();
  const before = await viewport.evaluate((element) => element.scrollLeft);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
  expect(await viewport.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe("none");
  await page.screenshot({ path: "test-results/photo-preview-mobile.png", fullPage: true });
  await dialog.getByRole("button", { name: "Fit photo to view" }).click();
  await expect(dialog.locator("[data-photo-zoom]")).toHaveText("100%");
  await expect(dialog.getByRole("button", { name: "Zoom out photo", exact: true })).toBeDisabled();
  expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  expect(await image.getAttribute("src")).toBe(source);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("[data-run]").click();
  await expect(page.locator(".scan-item")).toHaveCount(1);
  expect(uploadedImage).toBe(source);
  expect(errors).toEqual([]);
});
