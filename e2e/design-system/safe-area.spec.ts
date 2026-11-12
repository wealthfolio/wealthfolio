import { expect, test, type Locator, type Page } from "@playwright/test";
import { nextFrames, settle } from "./gallery";

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
const portrait = { top: 24, right: 0, bottom: 48, left: 0 };
const landscape = { top: 24, right: 48, bottom: 0, left: 0 };

async function open(page: Page, kind: string, insets: Insets, dir = "ltr", legacyHeight = false) {
  await page.goto(
    `/e2e/design-system/?safeArea=${kind}&dir=${dir}${legacyHeight ? "&legacyHeight" : ""}`,
  );
  await expect(page.getByRole("heading", { name: "Overlay safe areas" })).toBeVisible();
  await page.evaluate((edges) => {
    for (const [edge, inset] of Object.entries(edges)) {
      document.documentElement.style.setProperty(`--android-inset-${edge}`, `${inset}px`);
    }
  }, insets);
  await page.getByRole("button", { name: "Open form", exact: true }).click();
  const popup = page.getByRole(kind === "alert" ? "alertdialog" : "dialog", {
    name: kind === "alert" ? "Safe area alert" : "Safe area form",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await settle(page);
  return popup;
}

async function expectSafe(page: Page, element: Locator, insets: Insets) {
  const rect = await element.boundingBox();
  expect(rect).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(insets.left - 1);
  expect(rect!.y).toBeGreaterThanOrEqual(insets.top - 1);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width - insets.right + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height - insets.bottom + 1);
}

for (const kind of ["dialog", "bottom", "right", "inline-end", "alert"]) {
  for (const dir of ["ltr", "rtl"]) {
    test(`${kind} in ${dir} keeps its full actions above three-button navigation with p-0`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 412, height: 915 });
      const popup = await open(page, kind, portrait, dir);
      await expectSafe(page, popup, portrait);
      const action = popup.getByRole("button", {
        name: kind === "alert" ? "Cancel" : "Continue",
        exact: true,
      });
      await expectSafe(page, action, portrait);
      await action.click();
      if (kind !== "alert") await expect(popup.getByRole("status")).toHaveText("Next step");
      else await expect(popup).toBeHidden();
    });
  }
}

for (const kind of ["dialog", "bottom", "right", "inline-end", "alert"]) {
  test(`${kind} respects landscape side bars and available height`, async ({ page }) => {
    await page.setViewportSize({ width: 915, height: 412 });
    const popup = await open(page, kind, landscape, "rtl");
    await expectSafe(page, popup, landscape);
    await expectSafe(
      page,
      popup.getByRole("button", { name: kind === "alert" ? "Cancel" : "Continue", exact: true }),
      landscape,
    );
    if (kind !== "alert") {
      await expectSafe(page, popup.getByRole("button", { name: "Close", exact: true }), landscape);
    }
  });
}

test("nested dialogs get independent safe viewports without duplicate padding", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const parent = await open(page, "right", portrait);
  await expect(parent.getByTestId("custom-footer")).toHaveCSS("padding-bottom", "16px");
  await parent.getByRole("button", { name: "Nested dialog", exact: true }).click();
  const nested = page.getByRole("dialog", { name: "Nested form", exact: true });
  await expect(nested).toBeVisible();
  await settle(page);
  await expectSafe(page, nested, portrait);
  const frame = nested.locator("..");
  const rect = await frame.boundingBox();
  expect(rect!.height).toBeCloseTo(915 - portrait.top - portrait.bottom, 0);
  await nested.getByRole("button", { name: "Close", exact: true }).click();
  await expect(parent).toBeVisible();
  await expectSafe(page, parent.getByRole("button", { name: "Continue", exact: true }), portrait);
});

test("zero insets preserve the desktop dialog's width and design padding", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const popup = await open(page, "dialog", { top: 0, right: 0, bottom: 0, left: 0 });
  expect((await popup.boundingBox())!.width).toBeCloseTo(512, 0);
  await expect(popup).toHaveCSS("padding-bottom", "0px");
  await expect(popup.getByTestId("custom-footer")).toHaveCSS("padding-bottom", "16px");
});

test("existing addon max-h classes keep their height preference", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const popup = await open(page, "dialog", portrait, "ltr", true);
  await expect(popup).toHaveCSS("max-height", "450px");
  expect((await popup.boundingBox())!.height).toBeCloseTo(450, 0);
  await expectSafe(page, popup, portrait);
});

for (const kind of ["dialog", "bottom", "right"]) {
  test(`${kind} keeps actions above an overlay keyboard and restores its height`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    const popup = await open(page, kind, portrait);
    const original = (await popup.boundingBox())!.height;
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "340px");
    });
    const keyboard = { ...portrait, bottom: 340 };
    await expectSafe(page, popup, keyboard);
    const action = popup.getByRole("button", { name: "Continue", exact: true });
    await expectSafe(page, action, keyboard);
    await action.click();
    await expect(popup.getByRole("status")).toHaveText("Next step");
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "0px");
    });
    await expectSafe(page, popup, portrait);
    expect((await popup.boundingBox())!.height).toBeCloseTo(original, 0);
  });
}

for (const kind of ["dialog", "bottom", "right", "inline-end", "alert"]) {
  test(`${kind} follows an iOS visual viewport through keyboard resize, pan and dismissal`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript(() => {
      const viewport = window.visualViewport!;
      const state = { height: 915, offsetTop: 0 };
      Object.defineProperties(viewport, {
        height: { configurable: true, get: () => state.height },
        offsetTop: { configurable: true, get: () => state.offsetTop },
      });
      Object.assign(window, {
        setTestVisualViewport(height: number, offsetTop = 0) {
          Object.assign(state, { height, offsetTop });
          viewport.dispatchEvent(new Event("resize"));
          viewport.dispatchEvent(new Event("scroll"));
        },
      });
    });
    const popup = await open(page, kind, portrait);
    const original = (await popup.boundingBox())!.height;
    const action = popup.getByRole("button", {
      name: kind === "alert" ? "Cancel" : "Continue",
      exact: true,
    });
    const resize = async (height: number, offsetTop = 0) => {
      await page.evaluate(
        ([height, offsetTop]) => {
          const testWindow = window as typeof window & {
            setTestVisualViewport: (height: number, offsetTop: number) => void;
          };
          testWindow.setTestVisualViewport(height, offsetTop);
        },
        [height, offsetTop],
      );
      await nextFrames(page);
    };
    await resize(520);
    await expectSafe(page, popup, { ...portrait, bottom: 395 });
    await expectSafe(page, action, { ...portrait, bottom: 395 });
    // WKWebView can shrink innerHeight during panning while fixed containers
    // and documentElement.clientHeight retain their original layout height.
    await page.evaluate(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    });
    await resize(520, 40);
    await expectSafe(page, popup, { ...portrait, top: 64, bottom: 355 });
    await expectSafe(page, action, { ...portrait, top: 64, bottom: 355 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "400px");
    });
    await expectSafe(page, action, { ...portrait, top: 64, bottom: 400 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "0px");
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 915 });
    });
    await resize(915);
    expect((await popup.boundingBox())!.height).toBeCloseTo(original, 0);
    await action.click();
    if (kind === "alert") await expect(popup).toBeHidden();
    else await expect(popup.getByRole("status")).toHaveText("Next step");
  });
}

for (const dir of ["ltr", "rtl"]) {
  test(`short mobile dialogs fit their content and long dialogs scroll safely in ${dir}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.goto(`/e2e/design-system/?safeArea=dialog&contentSized&dir=${dir}`);
    await page.getByRole("button", { name: "Open form", exact: true }).click();
    const popup = page.getByRole("dialog", { name: "Safe area form", exact: true });
    await expect(popup).toBeVisible();
    await settle(page);
    const shortHeight = (await popup.boundingBox())!.height;
    expect(shortHeight).toBeLessThan(600);
    const footer = popup.getByTestId("custom-footer");
    await expect(footer).toBeInViewport();
    const lastControl = popup.getByRole("button", { name: "Nested dialog", exact: true });
    expect(
      (await footer.boundingBox())!.y -
        ((await lastControl.boundingBox())!.y + (await lastControl.boundingBox())!.height),
    ).toBeLessThan(48);
    await popup.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(popup.getByRole("status")).toHaveText("Next step");

    await page.goto(`/e2e/design-system/?safeArea=dialog&contentSized&rows=60&dir=${dir}`);
    await page.getByRole("button", { name: "Open form", exact: true }).click();
    await expect(popup).toBeVisible();
    await settle(page);
    expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(990);
    expect((await popup.boundingBox())!.height).toBeGreaterThan(shortHeight);
    await expect(popup.getByTestId("custom-footer")).toBeInViewport();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "400px"),
    );
    await nextFrames(page);
    await expectSafe(page, popup, { top: 0, left: 0, right: 0, bottom: 400 });
    await expectSafe(page, popup.getByRole("button", { name: "Continue", exact: true }), {
      top: 0,
      left: 0,
      right: 0,
      bottom: 400,
    });
    const body = popup.locator("div.overflow-y-auto");
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(popup.getByText("Synthetic row 60", { exact: true })).toBeInViewport();
  });
}
