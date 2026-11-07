import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@wealthfolio/ui";
import { useSyncExternalStore, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileStackContext, type MobileStackContextValue } from "./mobile-stack-contexts";
import { MobileStackOutlet } from "./mobile-stack-outlet";
import { applyNavigation, coldStart, type StackConfig, type StackState } from "./stack-model";

const pages = vi.hoisted(() => ({ withPopup: false, withField: false, withLateHeading: false }));
// Each screen's page: nothing, an open dialog titled with the page's path, a
// text field labelled with it, or a heading with it once loading ends.
vi.mock("@/app-screen-routes", () => ({
  AppScreenRoutes: ({ location }: { location?: { pathname: string } }) =>
    pages.withPopup ? (
      <PagePopup title={location?.pathname ?? ""} />
    ) : pages.withField ? (
      <input aria-label={location?.pathname} />
    ) : pages.withLateHeading ? (
      <LateHeading title={location?.pathname ?? ""} />
    ) : null,
}));

// Whether pages showing a heading once loaded have finished loading.
const loading = {
  done: false,
  listeners: new Set<() => void>(),
  finish() {
    loading.done = true;
    for (const listener of loading.listeners) listener();
  },
  subscribe(listener: () => void) {
    loading.listeners.add(listener);
    return () => loading.listeners.delete(listener);
  },
};

function LateHeading({ title }: { title: string }) {
  const done = useSyncExternalStore(loading.subscribe, () => loading.done);
  return done ? <h1>{title}</h1> : <p>Loading</p>;
}

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
    guardScreen: () => () => undefined,
    guardedScreens: new Set(),
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

describe("tabs kept mounted", () => {
  it("keeps the screens of the tab shown and the two shown before it", () => {
    const fourTabs: StackConfig = {
      tabs: ["a", "b", "c", "d"].map((id) => ({ id, rootPath: `/${id}` })),
      topLevelPaths: ["/a", "/b", "/c", "/d"],
    };
    const loc = (pathname: string) => ({
      pathname,
      search: "",
      hash: "",
      state: null,
      key: pathname,
    });
    let state = coldStart(fourTabs, loc("/a"));
    for (const tab of ["b", "c", "d"]) {
      state = applyNavigation(state, { action: "PUSH", location: loc(`/${tab}`) }, fourTabs);
    }
    expect(state.recentTabs).toEqual(["d", "c", "b", "a"]);
    expect(mountedScreens(state)).toEqual(["b:1", "c:2", "d:3"]);
  });
});

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

  it("does not start on a screen holding unsaved work", () => {
    Object.assign(platform, { isIOS: true, isTauri: true });
    pages.withField = true;
    HTMLElement.prototype.setPointerCapture = () => undefined;
    render(outletFor(stackOf(2), { guardedScreens: new Set(["holdings:1"]) }));
    const field = screen.getByLabelText("/holdings/A1");
    field.focus();

    const pointer = { pointerId: 1, isPrimary: true, pointerType: "touch" };
    fireEvent.pointerDown(field, { ...pointer, clientX: 5, clientY: 400 });
    fireEvent.pointerMove(field, { ...pointer, clientX: 105, clientY: 400 });
    // The swipe never started, so it did not take the keyboard down either.
    expect(document.activeElement).toBe(field);
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

describe("focus after a push", () => {
  afterEach(() => {
    pages.withPopup = false;
    pages.withLateHeading = false;
    loading.done = false;
    vi.restoreAllMocks();
  });

  async function pushLoadingScreen(overrides: Partial<MobileStackContextValue> = {}) {
    pages.withLateHeading = true;
    const view = render(outletFor(stackOf(1)), { reactStrictMode: true });
    const { container, rerender } = view;
    rerender(outletFor(stackOf(2), overrides));
    const layer = container.querySelector<HTMLElement>('[data-stack-screen="holdings:1"]')!;
    const under = container.querySelector<HTMLElement>('[data-stack-screen="holdings:0"]')!;
    // Still loading when the push settles, so the screen itself takes focus.
    await waitFor(() => expect(under).not.toBeVisible());
    await waitFor(() => expect(document.activeElement).toBe(layer));
    return { ...view, layer };
  }

  it.each([false, true])("moves focus to a late heading (instant push: %s)", async (instant) => {
    const { layer } = await pushLoadingScreen({ historyDriven: instant, popAnimated: instant });
    act(() => loading.finish());
    const heading = await waitFor(() => {
      const found = layer.querySelector("h1");
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("leaves focus where the user moved it before the heading renders", async () => {
    const { layer } = await pushLoadingScreen();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      elsewhere.focus();
      act(() => loading.finish());
      await waitFor(() => expect(layer.querySelector("h1")).not.toBeNull());
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  function switchTab(state: StackState) {
    return applyNavigation(
      state,
      {
        action: "PUSH",
        location: { pathname: "/settings", search: "", hash: "", state: null, key: "settings" },
      },
      {
        ...config,
        tabs: [...config.tabs, { id: "settings", rootPath: "/settings" }],
        topLevelPaths: [...config.topLevelPaths, "/settings"],
      },
    );
  }

  it.each(["push", "pop", "tab switch", "unmount"] as const)(
    "stops watching the loading screen on %s",
    async (navigation) => {
      const observe = vi.spyOn(MutationObserver.prototype, "observe");
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
      const { layer, rerender, unmount } = await pushLoadingScreen();
      const index = observe.mock.calls.findIndex(([target]) => target === layer);
      expect(index).toBeGreaterThanOrEqual(0);
      const observer = observe.mock.contexts[index];
      expect(disconnect.mock.contexts).not.toContain(observer);
      if (navigation === "unmount") {
        unmount();
      } else {
        const next =
          navigation === "tab switch"
            ? switchTab(stackOf(2))
            : stackOf(navigation === "push" ? 3 : 1);
        rerender(outletFor(next));
      }
      expect(disconnect.mock.contexts).toContain(observer);
    },
  );

  it("does not focus an inert screen when a tab switch interrupts its push", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    pages.withLateHeading = true;
    const { container, rerender } = render(outletFor(stackOf(1)), { reactStrictMode: true });
    rerender(outletFor(stackOf(2)));
    rerender(outletFor(switchTab(stackOf(2))));
    const hidden = container.querySelector<HTMLElement>('[data-stack-screen="holdings:1"]')!;
    expect(hidden).not.toBeVisible();
    expect(hidden).toHaveAttribute("inert");
    expect(document.activeElement).not.toBe(hidden);
    expect(observe.mock.calls.some(([target]) => target === hidden)).toBe(false);
  });

  it("keeps waiting when the same screen updates its URL", async () => {
    const { layer, rerender } = await pushLoadingScreen();
    const updated = applyNavigation(
      stackOf(2),
      {
        action: "REPLACE",
        location: {
          pathname: "/holdings/A1",
          search: "?tab=activities",
          hash: "",
          state: null,
          key: "section",
        },
      },
      config,
    );
    rerender(outletFor(updated));
    act(() => loading.finish());
    await waitFor(() => expect(document.activeElement).toBe(layer.querySelector("h1")));
  });

  it("focuses a heading already rendered when the push settles", async () => {
    pages.withLateHeading = true;
    loading.done = true;
    const { container, rerender } = render(outletFor(stackOf(1)), { reactStrictMode: true });
    rerender(outletFor(stackOf(2)));
    const layer = container.querySelector<HTMLElement>('[data-stack-screen="holdings:1"]')!;
    await waitFor(() => expect(document.activeElement).toBe(layer.querySelector("h1")));
  });

  it("restores focus on pop without moving it when the heading renders", async () => {
    const { layer, rerender, container } = await pushLoadingScreen();
    const field = document.createElement("input");
    layer.append(field);
    field.focus();
    rerender(outletFor(stackOf(3)));
    await waitFor(() => expect(layer).not.toBeVisible());
    rerender(outletFor(stackOf(2)));
    await waitFor(() =>
      expect(container.querySelector('[data-stack-screen="holdings:2"]')).toBeNull(),
    );
    expect(document.activeElement).toBe(field);
    act(() => loading.finish());
    await waitFor(() => expect(layer.querySelector("h1")).not.toBeNull());
    expect(document.activeElement).toBe(field);
  });

  it("leaves focus in a dialog the pushed screen's page opened", async () => {
    pages.withPopup = true;
    const { container, rerender } = render(outletFor(stackOf(1)));
    rerender(outletFor(stackOf(2)));
    // Found through its screen's portal: a role query would also match dialogs
    // other tests in this file left open.
    const dialog = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-portal-scope="holdings:1"] [role="dialog"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    // The push settles once the screen underneath is hidden; then the stack moves
    // focus unless the page already put it somewhere, as this dialog did.
    const under = container.querySelector<HTMLElement>('[data-stack-screen="holdings:0"]')!;
    await waitFor(() => expect(under).not.toBeVisible());
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });
});
