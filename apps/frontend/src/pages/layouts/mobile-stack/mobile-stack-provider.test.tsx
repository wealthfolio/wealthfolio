import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DatePickerInput, PortalScope } from "@wealthfolio/ui";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StackScreenContext } from "./mobile-stack-contexts";
import { useLeaveGuard, useMobileStack } from "./use-mobile-stack";
import { MobileStackProvider } from "./mobile-stack-provider";
import type { StackConfig } from "./stack-model";

const android = vi.hoisted(() => ({
  handler: null as null | (() => void),
  listening: 0,
  isAndroid: true,
}));

vi.mock("@/adapters", () => ({
  listenBackButton: (handler: () => void) => {
    android.handler = handler;
    android.listening += 1;
    return Promise.resolve(() => {
      android.listening -= 1;
      return Promise.resolve();
    });
  },
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isAndroid: android.isAndroid, isTauri: true }),
}));

const config: StackConfig = {
  tabs: [{ id: "holdings", rootPath: "/holdings" }],
  topLevelPaths: ["/dashboard", "/holdings"],
};

let navigate: ReturnType<typeof useNavigate> = () => undefined;
let pathname = "";
let popAnimated: boolean | null | undefined;
let openTab: (tabId: string) => void = () => undefined;
let stackIndex = 0;

function Probe() {
  navigate = useNavigate();
  pathname = useLocation().pathname;
  const stack = useMobileStack();
  popAnimated = stack?.popAnimated;
  openTab = stack?.openTab ?? (() => undefined);
  stackIndex = stack?.state.index ?? 0;
  return null;
}

/** Adds an open popup to the page, in the portal of `scope` when given. */
function openPopup(scope?: string) {
  const portal = document.createElement("div");
  portal.setAttribute("data-test-overlay", "");
  if (scope) portal.setAttribute("data-portal-scope", scope);
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("data-open", "");
  portal.append(popup);
  document.body.append(portal);
  return portal;
}

function renderStack(start = "/holdings") {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <MobileStackProvider config={config}>
        <Probe />
      </MobileStackProvider>
    </MemoryRouter>,
  );
}

describe("Android Back on the phone stack", () => {
  beforeEach(() => Object.assign(android, { handler: null, listening: 0, isAndroid: true }));
  afterEach(() => document.querySelectorAll("[data-test-overlay]").forEach((el) => el.remove()));

  it("leaves Back to Android at a tab's first screen", async () => {
    renderStack();
    await Promise.resolve();
    expect(android.listening).toBe(0);
  });

  it("pops the stack while there is a screen to go back to", async () => {
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    act(() => android.handler?.());
    await waitFor(() => expect(pathname).toBe("/holdings"));
    await waitFor(() => expect(android.listening).toBe(0));
  });

  it("closes an open popup before leaving the screen", async () => {
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-open", "");
    dialog.setAttribute("data-test-overlay", "");
    document.body.append(dialog);
    const escapes = vi.fn();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") escapes();
      },
      { once: true },
    );

    act(() => android.handler?.());
    expect(escapes).toHaveBeenCalledTimes(1);
    expect(pathname).toBe("/holdings/AMD");
  });

  it("leaves a popup on a screen out of sight to that screen", async () => {
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    // The list under the pushed screen keeps a menu that was open on it.
    const portal = document.createElement("div");
    portal.setAttribute("data-portal-scope", "holdings:0");
    portal.setAttribute("data-test-overlay", "");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-open", "");
    portal.append(menu);
    document.body.append(portal);

    act(() => android.handler?.());
    await waitFor(() => expect(pathname).toBe("/holdings"));
  });

  it("closes a popup of the screen on top first", async () => {
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    const portal = document.createElement("div");
    portal.setAttribute("data-portal-scope", "holdings:1");
    portal.setAttribute("data-test-overlay", "");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-open", "");
    portal.append(menu);
    document.body.append(portal);
    const escapes = vi.fn();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") escapes();
      },
      { once: true },
    );

    act(() => android.handler?.());
    expect(escapes).toHaveBeenCalledTimes(1);
    expect(pathname).toBe("/holdings/AMD");
  });

  it("closes a popup at a tab's first screen, then leaves Back to Android again", async () => {
    renderStack();
    const popup = openPopup();
    await waitFor(() => expect(android.listening).toBe(1));
    const escapes = vi.fn();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") escapes();
      },
      { once: true },
    );

    act(() => android.handler?.());
    expect(escapes).toHaveBeenCalledTimes(1);
    expect(pathname).toBe("/holdings");

    popup.remove();
    await waitFor(() => expect(android.listening).toBe(0));
  });

  it("leaves Back to Android when the only open popup is on a screen out of sight", async () => {
    renderStack();
    openPopup("holdings:99");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(android.listening).toBe(0);
  });

  it("does not take over Back on other platforms", async () => {
    android.isAndroid = false;
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    await Promise.resolve();
    expect(android.listening).toBe(0);
  });
});

describe("history steps the browser animated", () => {
  function popState(animated?: boolean) {
    const event = new PopStateEvent("popstate");
    if (animated !== undefined) {
      Object.defineProperty(event, "hasUAVisualTransition", { value: animated });
    }
    act(() => void window.dispatchEvent(event));
  }

  it("follows what the browser says it did", () => {
    renderStack();
    popState(true);
    expect(popAnimated).toBe(true);
    popState(false);
    expect(popAnimated).toBe(false);
  });

  it("is unknown where the browser does not say", () => {
    renderStack();
    popState();
    expect(popAnimated).toBeNull();
  });
});

describe("tapping the tab that is shown", () => {
  it("returns to its first screen through history, keeping the screens as forward entries", () => {
    renderStack();
    act(() => void navigate("/holdings/AMD"));
    act(() => void navigate("/holdings/MSFT"));

    act(() => openTab("holdings"));
    expect(pathname).toBe("/holdings");
    act(() => void navigate(1));
    expect(pathname).toBe("/holdings/AMD");
  });
});

describe("Android Back with a date picker open", () => {
  beforeEach(() => Object.assign(android, { handler: null, listening: 0, isAndroid: true }));

  it("closes the picker's calendar before leaving the screen", async () => {
    render(
      <MemoryRouter initialEntries={["/holdings"]}>
        <MobileStackProvider config={config}>
          <Probe />
          <DatePickerInput value={new Date(2026, 3, 1)} onChange={() => undefined} />
        </MobileStackProvider>
      </MemoryRouter>,
    );
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    const [openCalendar] = screen
      .getAllByRole("button")
      .filter((button) => /pick/i.test(button.getAttribute("aria-label") ?? ""));
    act(() => void fireEvent.click(openCalendar));
    await screen.findByRole("dialog");

    act(() => android.handler?.());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pathname).toBe("/holdings/AMD");
  });

  it("leaves a picker open on a screen out of sight to that screen", async () => {
    render(
      <MemoryRouter initialEntries={["/holdings"]}>
        <MobileStackProvider config={config}>
          <Probe />
          <PortalScope name="holdings:0">
            <DatePickerInput value={new Date(2026, 3, 1)} onChange={() => undefined} />
          </PortalScope>
        </MobileStackProvider>
      </MemoryRouter>,
    );
    const [openCalendar] = screen
      .getAllByRole("button")
      .filter((button) => /pick/i.test(button.getAttribute("aria-label") ?? ""));
    act(() => void fireEvent.click(openCalendar));
    await screen.findByRole("dialog");
    // The list's picker stays open under the holding pushed over it.
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    act(() => android.handler?.());
    await waitFor(() => expect(pathname).toBe("/holdings"));
  });
});

describe("tabs in the Android app", () => {
  const tabsConfig: StackConfig = {
    tabs: [
      { id: "dashboard", rootPath: "/dashboard" },
      { id: "holdings", rootPath: "/holdings" },
    ],
    topLevelPaths: ["/dashboard", "/holdings"],
    homeTab: "dashboard",
  };
  const renderTabs = (start: string) =>
    render(
      <MemoryRouter initialEntries={[start]}>
        <MobileStackProvider config={tabsConfig}>
          <Probe />
        </MobileStackProvider>
      </MemoryRouter>,
    );
  beforeEach(() => Object.assign(android, { handler: null, listening: 0, isAndroid: true }));

  it("switch tabs without a history entry", () => {
    renderTabs("/dashboard");
    act(() => openTab("holdings"));
    expect(pathname).toBe("/holdings");
    expect(stackIndex).toBe(0);
  });

  it("take a history entry per switch elsewhere", () => {
    android.isAndroid = false;
    renderTabs("/dashboard");
    act(() => openTab("holdings"));
    expect(stackIndex).toBe(1);
  });

  it("go back to the home tab from another tab's first screen, then leave Back to Android", async () => {
    renderTabs("/holdings");
    await waitFor(() => expect(android.listening).toBe(1));
    act(() => android.handler?.());
    expect(pathname).toBe("/dashboard");
    await waitFor(() => expect(android.listening).toBe(0));
  });
});

describe("a screen holding unsaved work", () => {
  beforeEach(() => Object.assign(android, { handler: null, listening: 0, isAndroid: true }));

  function Wizard({ onAttempt }: { onAttempt: () => void }) {
    useLeaveGuard(true, onAttempt);
    return null;
  }

  it("asks the page instead of leaving on Android's Back", async () => {
    const onAttempt = vi.fn();
    render(
      <MemoryRouter initialEntries={["/holdings"]}>
        <MobileStackProvider config={config}>
          <Probe />
          <StackScreenContext.Provider value="holdings:1">
            <Wizard onAttempt={onAttempt} />
          </StackScreenContext.Provider>
        </MobileStackProvider>
      </MemoryRouter>,
    );
    act(() => void navigate("/holdings/AMD"));
    await waitFor(() => expect(android.listening).toBe(1));

    act(() => android.handler?.());
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(pathname).toBe("/holdings/AMD");
  });
});

describe("tapping the tab shown at its first screen", () => {
  it("scrolls the screen back to its top", () => {
    const scrollTo = vi.fn();
    render(
      <MemoryRouter initialEntries={["/holdings"]}>
        <MobileStackProvider config={config}>
          <Probe />
          <div data-stack-screen="holdings:0">
            {/* A section of the page, scrolled down. */}
            <div
              style={{ overflowY: "auto" }}
              ref={(el) => {
                if (!el) return;
                Object.defineProperty(el, "scrollTop", { value: 200, configurable: true });
                el.scrollTo = scrollTo;
              }}
            />
          </div>
        </MobileStackProvider>
      </MemoryRouter>,
    );
    act(() => openTab("holdings"));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(pathname).toBe("/holdings");
  });
});
