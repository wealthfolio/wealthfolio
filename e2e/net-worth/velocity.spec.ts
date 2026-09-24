import { expect, test } from "@playwright/test";

for (const width of [320, 1280]) {
  for (const language of ["en", "de"]) {
    test(`separate monthly drivers fit at ${width}px in ${language}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`/e2e/net-worth/?language=${language}`);
      const card = page.getByRole("region", { name: "Monthly pace card" });
      await expect(
        card.getByText(language === "en" ? "Portfolio gains/losses" : "Portfoliogewinne/-verluste"),
      ).toBeVisible();
      await expect(
        card.getByText(
          language === "en"
            ? "Other asset value changes"
            : "Wertänderungen sonstiger Vermögenswerte",
        ),
      ).toBeVisible();
      await expect(card).toContainText("9% · +");
      await expect(card).toContainText("34% · -");
      await page.evaluate(() => document.fonts.ready);
      expect(
        await card.evaluate((root) => {
          const errors: string[] = [];
          const bounds = root.getBoundingClientRect();
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.left < bounds.left || rect.right > bounds.right)
                errors.push(node.textContent);
            }
          }
          return errors;
        }),
      ).toEqual([]);
    });
  }
}
