import { expect, test } from "@playwright/test";

function layoutViolations(root: HTMLElement) {
  const errors: string[] = [];
  // Use painted text rectangles: element boxes alone miss text spilling out
  // of a fixed-width label (the original w-12 regression).
  const bounds = root.firstElementChild!.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const parent = node.parentElement!.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
        errors.push(`Outside card: ${node.textContent}`);
      }
      if (rect.left < parent.left - 1 || rect.right > parent.right + 1) {
        errors.push(`Outside label: ${node.textContent}`);
      }
    }
  }
  // A flex child can spill into the neighboring grid column even when
  // the grid cell itself is correctly positioned (the min-w-12-only fix).
  for (const element of root.querySelectorAll("div, span")) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const parent = element.parentElement!.getBoundingClientRect();
    if (rect.left < parent.left - 1 || rect.right > parent.right + 1) {
      errors.push(`Outside cell: ${element.textContent}`);
    }
  }
  // Include category rows and the net-worth footer. Compare adjacent cells
  // only when they occupy the same line, allowing the narrow stacked layout.
  const rows = [...root.querySelectorAll('[role="button"]')];
  const total = [...root.querySelectorAll("div")].find((element) =>
    [...element.children].some((child) => child.textContent?.trim() === "=Nettovermögen"),
  );
  if (total) rows.push(total);
  else errors.push("Net worth footer was not checked");
  for (const row of rows) {
    const cells = [...row.children].map((element) => element.getBoundingClientRect());
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i],
          b = cells[j];
        const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (horizontal > 1 && vertical > 1) errors.push(`Overlapping cells: ${row.textContent}`);
      }
    }
  }
  return errors;
}

for (const width of [320, 592, 992]) {
  test(`German growth values stay contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/e2e/net-worth/");
    const card = page.getByRole("main", { name: "Net worth card" });
    await expect(card.getByRole("button", { name: /^Investments / })).toBeVisible();
    await expect(card.getByText("123.456,8×", { exact: true })).toBeVisible();
    await expect(card.getByText(/^=\s*Nettovermögen$/)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    if (width === 992) {
      // With ample space, a compact multiple should not break mid-number.
      const lines = await card.getByText("123.456,8×", { exact: true }).evaluate((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return range.getClientRects().length;
      });
      expect(lines).toBe(1);
    }

    const violations = await card.evaluate(layoutViolations);
    expect(violations).toEqual([]);
  });
}

// Card widths straddle every container-query boundary, independently of viewport.
const cardWidths = [240, 288, 320, 447, 448, 560, 639, 640, 767, 768, 960];
for (const fallback of [false, true]) {
  for (const width of cardWidths) {
    test(`columns align at card ${width}px, fallback=${fallback}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1200 });
      await page.goto(`/e2e/net-worth/?width=${width}&fallback=${Number(fallback)}`);
      const card = page.getByRole("main", { name: "Net worth card" });
      await expect(card.getByText("123.456,8×", { exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (fallback) {
        const tracks = await card
          .getByRole("button", { name: /^Investments / })
          .evaluate((row) => getComputedStyle(row).gridTemplateColumns);
        expect(tracks).not.toContain("subgrid");
      }
      for (const scenario of ["growth", "loss", "zero", "new", "negative", "assets-only"]) {
        await page.getByLabel("Scenario", { exact: true }).selectOption(scenario);
        const edges = await card.evaluate((root) => {
          // Header, category rows and footer all have four logical cells;
          // the share cell remains in the DOM when hidden on narrow cards.
          return [...root.querySelectorAll("div")]
            .filter((row) => row.children.length === 4 && row.classList.contains("items-baseline"))
            .map((row) => ({
              label: row.children[0].textContent,
              value: row.children[2].getBoundingClientRect().right,
              delta: row.children[3].getBoundingClientRect().right,
            }));
        });
        expect.soft(await card.evaluate(layoutViolations), `${scenario}: containment`).toEqual([]);
        expect(edges.length).toBeGreaterThanOrEqual(4);
        for (const edge of edges) {
          expect
            .soft(Math.abs(edge.value - edges[0].value), `${scenario}: Value ${edge.label}`)
            .toBeLessThanOrEqual(1);
          expect
            .soft(Math.abs(edge.delta - edges[0].delta), `${scenario}: Delta ${edge.label}`)
            .toBeLessThanOrEqual(1);
        }
      }
    });
  }
}

for (const fallback of [false, true]) {
  for (const width of cardWidths) {
    test(`sign stays with first digit at card ${width}px, fallback=${fallback}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 1200 });
      await page.goto(`/e2e/net-worth/?width=${width}&fallback=${Number(fallback)}`);
      const card = page.getByRole("main", { name: "Net worth card" });
      await expect(card.getByText("123.456,8×", { exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (fallback) {
        const tracks = await card
          .getByRole("button", { name: /^Investments / })
          .evaluate((row) => getComputedStyle(row).gridTemplateColumns);
        expect(tracks).not.toContain("subgrid");
      }
      for (const locale of ["de-DE", "en-US", "fr-FR", "ja-JP"]) {
        await page.getByLabel("Number locale").selectOption(locale);
        for (const scenario of ["growth", "loss", "negative", "extreme"]) {
          await page.getByLabel("Scenario", { exact: true }).selectOption(scenario);
          const result = await card.evaluate((root) => {
            const errors: string[] = [];
            let checked = 0;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              const signIndex = node.textContent?.search(/[+−-]/) ?? -1;
              if (signIndex < 0 || !/^[\s+−-]/.test(node.textContent ?? "")) continue;
              const parent = node.parentElement!;
              const descendants = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
              let digitNode: Node | undefined;
              let digitIndex = -1;
              while (descendants.nextNode()) {
                const index = descendants.currentNode.textContent?.search(/\d/) ?? -1;
                if (index >= 0) {
                  digitNode = descendants.currentNode;
                  digitIndex = index;
                  break;
                }
              }
              if (!digitNode) continue;
              const sign = document.createRange();
              sign.setStart(node, signIndex);
              sign.setEnd(node, signIndex + 1);
              const digit = document.createRange();
              digit.setStart(digitNode, digitIndex);
              digit.setEnd(digitNode, digitIndex + 1);
              const a = sign.getBoundingClientRect(),
                b = digit.getBoundingClientRect();
              if (!a.width || !b.width) continue;
              checked++;
              if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1)
                errors.push(`Separated sign: ${parent.textContent}`);
            }
            return { checked, errors };
          });
          expect(result.checked).toBeGreaterThan(0);
          expect.soft(result.errors, `${locale}, ${scenario}`).toEqual([]);
        }
      }
    });
  }
}

test("sections collapse independently and privacy hides amounts", async ({ page }) => {
  await page.goto("/e2e/net-worth/");
  const card = page.getByRole("main", { name: "Net worth card" });
  const investment = card.getByRole("button", { name: /^Investments / });
  const mortgage = card.getByRole("button", { name: /^Mortgage / });
  await expect(investment).toBeVisible();
  const assetsToggle = card.getByRole("button", { name: /^Vermögenswerte/ });
  const liabilitiesToggle = card.getByRole("button", { name: /^Verbindlichkeiten/ });
  await assetsToggle.click();
  await expect(investment).toBeHidden();
  await expect(mortgage).toBeVisible();
  await expect(card.getByText(/^=\s*Nettovermögen$/)).toBeVisible();
  await assetsToggle.click();
  await expect(investment).toBeVisible();
  await liabilitiesToggle.click();
  await expect(mortgage).toBeHidden();
  await expect(investment).toBeVisible();
  await page.getByLabel("Hide balances").check();
  await expect(investment.getByText("••••", { exact: true }).first()).toBeVisible();
  await expect(investment).not.toContainText("12,35");
});
