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
