import { expect, test, type Page } from "@playwright/test";

/** Painted rectangles of every flow label chip, plus the diagram's own bounds. */
async function labelBoxes(page: Page) {
  return page.locator("main svg.recharts-surface").evaluate((svg) => {
    const bounds = svg.getBoundingClientRect();
    const labels = [...svg.querySelectorAll("foreignObject span")]
      .map((span) => ({ text: span.textContent ?? "", rect: span.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .map(({ text, rect }) => ({
        text,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      }));
    return {
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      labels,
    };
  });
}

for (const dir of ["ltr", "rtl"] as const) {
  for (const width of [960, 640]) {
    test(`flow labels never overlap or clip at card ${width}px, ${dir}`, async ({ page }) => {
      await page.setViewportSize({ width: width + 64, height: 1200 });
      await page.goto(`/e2e/net-worth/?width=${width}&scenario=itemized`);
      await page.evaluate((direction) => (document.documentElement.dir = direction), dir);
      const card = page.getByRole("main", { name: "Net worth card" });
      await card.getByRole("button", { name: "Fluss anzeigen" }).click();

      await expect(card.getByRole("button", { name: /^Investments — / })).toBeVisible();
      await expect(card.getByRole("button", { name: /^3 kleinere Positionen — / })).toBeVisible();
      await expect(card.getByText("Schulden", { exact: true })).toBeVisible();

      const { bounds, labels } = await labelBoxes(page);
      expect(labels.length).toBeGreaterThan(8);
      for (const label of labels) {
        expect(label.top, `${label.text} clipped at top`).toBeGreaterThanOrEqual(bounds.top - 1);
        expect(label.bottom, `${label.text} clipped at bottom`).toBeLessThanOrEqual(
          bounds.bottom + 1,
        );
      }
      for (const [index, a] of labels.entries()) {
        for (const b of labels.slice(index + 1)) {
          const overlaps =
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1;
          expect(overlaps, `"${a.text}" overlaps "${b.text}"`).toBe(false);
        }
      }
    });
  }
}

test("flow stays expanded across reloads and collapses back to the bar", async ({ page }) => {
  await page.goto("/e2e/net-worth/?scenario=itemized");
  const card = page.getByRole("main", { name: "Net worth card" });
  await card.getByRole("button", { name: "Fluss anzeigen" }).click();
  await expect(card.locator("svg.recharts-surface")).toBeVisible();

  await page.reload();
  await expect(card.locator("svg.recharts-surface")).toBeVisible();
  await card.getByRole("button", { name: "Fluss ausblenden" }).click();
  await expect(card.locator("svg.recharts-surface")).toHaveCount(0);
});

test("privacy hides flow amounts", async ({ page }) => {
  await page.goto("/e2e/net-worth/?scenario=itemized");
  const card = page.getByRole("main", { name: "Net worth card" });
  await card.getByRole("button", { name: "Fluss anzeigen" }).click();
  await page.getByLabel("Hide balances").check();
  await expect(card.getByRole("button", { name: "Investments — ••••" })).toBeVisible();
});

test("showcase fans Investments in by account", async ({ page }) => {
  await page.goto("/e2e/net-worth/?scenario=showcase&language=en&locale=en-US");
  const card = page.getByRole("main", { name: "Net worth card" });
  await card.getByRole("button", { name: "Show flow" }).click();
  for (const account of ["401(k)", "Brokerage", "Roth IRA", "529 Plan"]) {
    await expect(card.getByRole("button", { name: `${account} — `, exact: false })).toBeVisible();
  }
  await expect(card.getByText("401(k)", { exact: true })).toBeVisible();
});
