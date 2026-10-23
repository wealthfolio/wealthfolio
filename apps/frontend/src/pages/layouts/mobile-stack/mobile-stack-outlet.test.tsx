import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileStackContext, type MobileStackContextValue } from "./mobile-stack-contexts";
import { MobileStackOutlet } from "./mobile-stack-outlet";
import { applyNavigation, coldStart, type StackConfig, type StackState } from "./stack-model";

const pages = vi.hoisted(() => ({ withPopup: false, withField: false }));
// Each screen's page: nothing, an open dialog titled with the page's path, or a
// text field labelled with it.
vi.mock("@/app-screen-routes", () => ({
  AppScreenRoutes: ({ location }: { location?: { pathname: string } }) =>
    pages.withPopup ? (
      <PagePopup title={location?.pathname ?? ""} />
    ) : pages.withField ? (
      <input aria-label={location?.pathname} />
    ) : null,
}));

function PagePopup({ title }: { title: string }) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}
const platform = vi.hoisted(() => ({ isIOS: false, isAndroid: false, isTauri: false }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }));

const config: StackConfig = {
  tabs: [{ id: "holdings", rootPath: "/holdings" }],
  topLevelPaths: ["/holdings"],
};

function stackOf(depth: number): StackState {
  let state = coldStart(config, {
    pathname: "/holdings",
    search: "",
    hash: "",
    state: null,
    key: "k0",
  });
  for (let i = 1; i < depth; i++) {
    state = applyNavigation(
      state,
      {
        action: "PUSH",
        location: { pathname: `/holdings/A${i}`, search: "", hash: "", state: null, key: `k${i}` },
      },
      config,
    );
  }
  return state;
}

function outletFor(state: StackState, overrides: Partial<MobileStackContextValue> = {}): ReactNode {
  const value: MobileStackContextValue = {
    state,
    config,
    back: () => undefined,
    openTab: () => undefined,
    historyDriven: false,
    popAnimated: null,
    ...overrides,
  };
  return (
    <MemoryRouter initialEntries={["/holdings"]}>
      <MobileStackContext.Provider value={value}>
        <MobileStackOutlet scrollProps={{}} />
      </MobileStackContext.Provider>
    </MemoryRouter>
  );
}

function mountedScreens(state: StackState) {
  const { container } = render(outletFor(state));
  return [...container.querySelectorAll("[data-stack-screen]")].map((el) =>
    el.getAttribute("data-stack-screen"),
  );
}

describe("screens kept mounted per tab", () => {
  it("keeps every screen of a short stack", () => {
    expect(mountedScreens(stackOf(4))).toEqual([
      "holdings:0",
      "holdings:1",
      "holdings:2",
      "holdings:3",
    ]);
  });

  it("keeps the tab's first screen and the three nearest the top of a deep stack", () => {
    expect(mountedScreens(stackOf(6))).toEqual([
      "holdings:0",
      "holdings:3",
      "holdings:4",
      "holdings:5",
    ]);
  });
});

/**
 * Whether a style rule on the page hides the element. jsdom's computed style
 * can't tell: it reports Base UI's portals as hidden either way.
 */
function hiddenByStyleRule(element: Element) {
  return [...document.querySelectorAll("style")].some((style) =>
    [...(style.sheet?.cssRules ?? [])].some(
      (rule) =>
        rule instanceof CSSStyleRule &&
        rule.style.display === "none" &&
        element.matches(rule.selectorText),
    ),
  );
}

describe("popups of screens out of sight", () => {
  afterEach(() => {
    pages.withPopup = false;
  });

  it("hides a popup left open on a screen once another one covers it", async () => {
    pages.withPopup = true;
    const popupOf = (title: string) => screen.getByText(title).closest("[data-portal-scope]");
    const { rerender } = render(outletFor(stackOf(1)));
    await waitFor(() => expect(popupOf("/holdings")).not.toBeNull());
    expect(hiddenByStyleRule(popupOf("/holdings")!)).toBe(false);

    rerender(outletFor(stackOf(2)));
    await waitFor(() => expect(popupOf("/holdings/A1")).not.toBeNull());
    expect(popupOf("/holdings")?.getAttribute("data-portal-scope")).toBe("holdings:0");
    expect(hiddenByStyleRule(popupOf("/holdings")!)).toBe(true);
    expect(hiddenByStyleRule(popupOf("/holdings/A1")!)).toBe(false);
  });
});

describe("a history step the browser animated itself", () => {
  afterEach(() => Object.assign(platform, { isIOS: false, isTauri: false }));

  /** Screens mounted right after history goes back from a pushed screen. */
  function afterHistoryBack(popAnimated: boolean | null) {
    const { container, rerender } = render(outletFor(stackOf(2)));
    rerender(outletFor(stackOf(1), { historyDriven: true, popAnimated }));
    return [...container.querySelectorAll("[data-stack-screen]")].map((el) =>
      el.getAttribute("data-stack-screen"),
    );
  }

  it("is not animated again", () => {
    expect(afterHistoryBack(true)).toEqual(["holdings:0"]);
  });

  it("is animated when the browser played no transition", () => {
    expect(afterHistoryBack(false)).toEqual(["holdings:0", "holdings:1"]);
  });

  it("is taken as animated in Safari when the browser does not say", () => {
    platform.isIOS = true;
    expect(afterHistoryBack(null)).toEqual(["holdings:0"]);
  });
});

describe("a back swipe in the iOS app", () => {
  afterEach(() => {
    Object.assign(platform, { isIOS: false, isTauri: false });
    pages.withField = false;
    delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  });

  it("takes the keyboard down as it starts", () => {
    Object.assign(platform, { isIOS: true, isTauri: true });
    pages.withField = true;
    render(outletFor(stackOf(2)));
    const field = screen.getByLabelText("/holdings/A1");
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = () => undefined;
    field.focus();
    expect(document.activeElement).toBe(field);

    const pointer = { pointerId: 1, isPrimary: true, pointerType: "touch" };
    fireEvent.pointerDown(field, { ...pointer, clientX: 5, clientY: 400 });
    fireEvent.pointerMove(field, { ...pointer, clientX: 105, clientY: 400 });
    expect(document.activeElement).not.toBe(field);
  });

  it("keeps the screen underneath shown when the page updates its own URL mid-swipe", () => {
    Object.assign(platform, { isIOS: true, isTauri: true });
    pages.withField = true;
    HTMLElement.prototype.setPointerCapture = () => undefined;
    const pushed = stackOf(2);
    const { container, rerender } = render(outletFor(pushed));
    const under = () =>
      container.querySelector<HTMLElement>('[data-stack-screen="holdings:0"]')!.style.display;

    const field = screen.getByLabelText("/holdings/A1");
    const pointer = { pointerId: 1, isPrimary: true, pointerType: "touch" };
    fireEvent.pointerDown(field, { ...pointer, clientX: 5, clientY: 400 });
    fireEvent.pointerMove(field, { ...pointer, clientX: 105, clientY: 400 });
    expect(under()).not.toBe("none");

    const sectionChanged = applyNavigation(
      pushed,
      {
        action: "REPLACE",
        location: {
          pathname: "/holdings/A1",
          search: "?tab=activities",
          hash: "",
          state: null,
          key: "k-section",
        },
      },
      config,
    );
    rerender(outletFor(sectionChanged));
    expect(under()).not.toBe("none");
  });
});
