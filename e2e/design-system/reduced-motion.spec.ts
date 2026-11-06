import { expect, test } from "@playwright/test";
import { nextFrames, openGallery, recordMotion, settle } from "./gallery";

// #2436: a Recharts dashed line writes a longer dash list on every frame of its
// entry animation. When reduced motion gave every property a 0.01ms transition,
// a transition between dash lists of different lengths took gigabytes in WebKit
// and Firefox. Reduced motion must not make anything transition.
test("dash patterns change without a transition when the system asks for reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGallery(page);
  const transitions = await page.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M0 10 L200 10");
    path.setAttribute("stroke", "currentColor");
    svg.append(path);
    document.body.append(svg);
    const style = getComputedStyle(path);
    path.setAttribute("stroke-dasharray", "5 5");
    void style.strokeDasharray;
    path.setAttribute("stroke-dasharray", "5 5 5 5 5 7");
    path.setAttribute("stroke-width", "3");
    void style.strokeDasharray;
    // WebKit also runs them on the shape's ::before and ::after.
    return document
      .getAnimations()
      .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
      .filter((transition) => (transition.effect as KeyframeEffect).target === path)
      .map((transition) =>
        [(transition.effect as KeyframeEffect).pseudoElement, transition.transitionProperty]
          .filter(Boolean)
          .join(" "),
      );
  });
  expect(transitions).toEqual([]);
});

test("an accordion opens without growing when the system asks for reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGallery(page);
  const motion = await recordMotion(page);
  await page.getByRole("button", { name: "Taxes" }).click();
  await expect(page.getByText("Synthetic tax explanation.")).toBeVisible();
  // A transition's first event arrives a frame after it starts.
  await nextFrames(page);
  await settle(page);
  expect((await motion()).filter((record) => record.moved > 0.5)).toEqual([]);
});

test("a button doesn't move when pressed and the system asks for reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGallery(page);
  const motion = await recordMotion(page);
  const button = page.getByRole("button", { name: "Primary action" });
  // Up to 1024 px wide, globals.css also gives every button a 200 ms
  // transition on all properties.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    if (!box) throw new Error("The button has no box.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await nextFrames(page);
    await settle(page);
    await page.mouse.up();
    await nextFrames(page);
    await settle(page);
    expect(
      (await motion()).filter((record) => record.moved > 0.5),
      `${width} px`,
    ).toEqual([]);
  }
});

test("the performance chart draws without animating when the system asks for reduced motion", async ({
  page,
}) => {
  // Counts writes to dash patterns from the first render on.
  await page.addInitScript(() => {
    const counter = window as unknown as { dashWrites: number };
    counter.dashWrites = 0;
    new MutationObserver((records) => {
      counter.dashWrites += records.length;
    }).observe(document, {
      attributes: true,
      attributeFilter: ["stroke-dasharray"],
      subtree: true,
    });
  });
  const dashWrites = async (reducedMotion: "reduce" | "no-preference") => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/e2e/design-system/?chart");
    await expect(page.locator("path.recharts-line-curve")).toHaveCount(2);
    // The lines draw in over 300 ms.
    await page.waitForTimeout(1000);
    return page.evaluate(() => (window as unknown as { dashWrites: number }).dashWrites);
  };
  // Without the setting both lines draw in, the benchmark by rewriting its dash
  // list every frame.
  expect(await dashWrites("no-preference")).toBeGreaterThan(5);
  expect(await dashWrites("reduce")).toBe(0);
});
