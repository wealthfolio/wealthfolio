import { expect, test } from "@playwright/test";

for (const width of [320, 1280]) {
  for (const language of ["en", "de"]) {
    test(`attention actions fit and link an existing property at ${width}px in ${language}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`/e2e/net-worth/?attention=1&language=${language}`);
      const card = page.getByRole("region", {
        name: language === "en" ? "Needs attention" : "Handlungsbedarf",
      });
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByRole("link")).toHaveCount(2);
      const linkText =
        language === "en"
          ? "Link a property to Home Mortgage"
          : "Immobilie mit Home Mortgage verknüpfen";
      if (width === 320) {
        await card.getByRole("button", { name: linkText, exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Home", exact: true }).click();
      } else {
        await card.getByRole("combobox").click();
        await page.getByRole("option", { name: "Home", exact: true }).click();
      }
      await expect(
        card.getByRole("button", { name: /Add a property|Immobilie hinzufügen/ }),
      ).toHaveCount(0);
      await expect(card.getByRole("link")).toHaveCount(2);

      // Reset the fixture to inspect the creation action as well.
      await page.reload();
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await card.evaluate((root) => {
          const bounds = root.getBoundingClientRect();
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const overflow: string[] = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            // Select triggers deliberately truncate long localized labels.
            if (node.parentElement?.closest('[role="combobox"], .truncate')) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))
                overflow.push(node.textContent ?? "");
            }
          }
          return overflow;
        }),
      ).toEqual([]);
      await card.screenshot({ path: test.info().outputPath("attention.png") });
      const addText =
        language === "en"
          ? "Add a property for Home Mortgage"
          : "Immobilie für Home Mortgage hinzufügen";
      if (width === 320) {
        await card.getByRole("button", { name: linkText, exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: addText, exact: true }).click();
      } else {
        await card.getByRole("combobox").click();
        await page.getByRole("option", { name: addText, exact: true }).click();
      }
      await expect(page.getByText("Property creation requested")).toBeVisible();
    });
  }
}

test("offers creation when no property exists", async ({ page }) => {
  await page.goto("/e2e/net-worth/?attention=1&property=0&language=en");
  const card = page.getByRole("region", { name: "Needs attention" });
  await expect(card.getByRole("combobox")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Add a property for Home Mortgage" }),
  ).toBeVisible();
});

test("offers a property for an untyped legacy liability with no recorded property", async ({
  page,
}) => {
  await page.goto("/e2e/net-worth/?attention=1&property=0&untyped=1&language=en");
  const card = page.getByRole("region", { name: "Needs attention" });
  await expect(
    card.getByText("Linking an existing property does not change your net worth."),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Add a property for Home Mortgage" }).click();
  await expect(page.getByText("Property creation requested")).toBeVisible();
});
