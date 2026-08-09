import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, test } from "@playwright/test";

async function createAccessibleArtifact(request: APIRequestContext) {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Accessibility release gate",
      favicon: "♿",
      content: `
        <main>
          <h1>Accessible artifact</h1>
          <p>This fixture exercises the viewer and sandbox landmarks.</p>
          <button type="button">Example action</button>
        </main>`,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}

const wcagTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

for (const theme of ["light", "dark"] as const) {
  test(`viewer and frame have no automated WCAG 2.2 AA violations in ${theme} theme`, async ({
    page,
    request,
  }) => {
    const artifact = await createAccessibleArtifact(request);
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem("oa-theme", selectedTheme);
    }, theme);

    await page.goto(`/a/${artifact.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.frameLocator("#oa-frame").getByRole("heading", {
        name: "Accessible artifact",
      }),
    ).toBeVisible();
    const hostResults = await new AxeBuilder({ page })
      .withTags(wcagTags)
      .exclude("#oa-frame")
      .analyze();
    expect(hostResults.violations).toEqual([]);

    await page.goto(`/a/${artifact.id}/frame`);
    const frameResults = await new AxeBuilder({ page })
      .withTags(wcagTags)
      .analyze();
    expect(frameResults.violations).toEqual([]);
  });
}

test("360px viewer is keyboard operable, visibly focused, and has no horizontal overflow", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const artifact = await createAccessibleArtifact(request);
  await page.goto(`/a/${artifact.id}`);

  const more = page.getByRole("button", { name: "More artifact controls" });
  await more.focus();
  await expect(more).toBeFocused();
  const focusStyle = await more.evaluate((element) => {
    const style = getComputedStyle(element);
    return { boxShadow: style.boxShadow, outline: style.outlineStyle };
  });
  expect(focusStyle.boxShadow !== "none" || focusStyle.outline !== "none").toBe(
    true,
  );
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");

  const theme = page.getByRole("button", { name: /theme/i });
  await theme.focus();
  await expect(theme).toBeFocused();
  const previousTheme = await page.locator("html").getAttribute("data-theme");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme",
    previousTheme ?? "",
  );

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
  const frameDimensions = await page
    .frameLocator("#oa-frame")
    .locator("html")
    .evaluate((element) => ({
      viewport: element.clientWidth,
      page: element.scrollWidth,
    }));
  expect(frameDimensions.page).toBeLessThanOrEqual(frameDimensions.viewport);

  const results = await new AxeBuilder({ page })
    .withTags(wcagTags)
    .exclude("#oa-frame")
    .analyze();
  expect(results.violations).toEqual([]);
});
