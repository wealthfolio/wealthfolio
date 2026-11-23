import { render } from "@testing-library/react";
import { OverlayViewport } from "@wealthfolio/ui/components/ui/overlay-viewport";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

// The numbers an iPhone 17e simulator reported with the keyboard open over a sheet:
// WKWebView shrank the page to the visible 475pt and scrolled it by 369pt.
function stubViewport({ height, offsetTop, innerHeight }: Record<string, number>) {
  vi.stubGlobal("visualViewport", {
    height,
    offsetTop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("innerHeight", innerHeight);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(844);
}

function renderViewport() {
  const { container } = render(
    <OverlayViewport>
      <div />
    </OverlayViewport>,
  );
  return container.querySelector<HTMLElement>("[data-slot=overlay-viewport]");
}

describe("OverlayViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drops the home-indicator inset while the keyboard covers it", () => {
    stubViewport({ height: 475, offsetTop: 369, innerHeight: 475 });
    const viewport = renderViewport();
    expect(viewport?.style.getPropertyValue("--overlay-safe-bottom")).toBe("0px");
  });

  it("brings the focused field back into view when the keyboard opens", () => {
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(844);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    // jsdom has no scrollIntoView; put one in for this test only.
    const original = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      HTMLElement.prototype.scrollIntoView = original;
    });
    const { getByRole } = render(
      <OverlayViewport>
        <textarea aria-label="Notes" />
      </OverlayViewport>,
    );
    getByRole("textbox", { name: "Notes" }).focus();
    expect(scrollIntoView).not.toHaveBeenCalled();

    Object.assign(viewport, { height: 475, offsetTop: 369 });
    vi.stubGlobal("innerHeight", 475);
    const onResize = viewport.addEventListener.mock.calls.find(([type]) => type === "resize")?.[1];
    onResize?.();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("keeps the home-indicator inset with no keyboard", () => {
    stubViewport({ height: 844, offsetTop: 0, innerHeight: 844 });
    const viewport = renderViewport();
    expect(viewport?.style.getPropertyValue("--overlay-safe-bottom")).toBe("");
  });
});
