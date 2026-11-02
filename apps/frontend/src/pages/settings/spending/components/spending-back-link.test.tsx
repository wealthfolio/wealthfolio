import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { StackScreenContext } from "@/pages/layouts/mobile-stack/mobile-stack-contexts";
import { MobileStackProvider } from "@/pages/layouts/mobile-stack/mobile-stack-provider";
import { useMobileStack } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import { SpendingBackLink } from "./spending-back-link";

vi.mock("@/adapters", () => ({
  listenBackButton: () => Promise.resolve(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isAndroid: false, isTauri: false }),
}));

let navigate: ReturnType<typeof useNavigate> = () => undefined;
let pathname = "";
let settingsStack: string[] = [];

function Probe() {
  navigate = useNavigate();
  pathname = useLocation().pathname;
  settingsStack =
    useMobileStack()?.state.stacks.settings?.map((screen) => screen.location.pathname) ?? [];
  return null;
}

describe("the Back to Spending link", () => {
  it("steps back to the Spending screen underneath instead of opening it again", () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <MobileStackProvider
          config={{ tabs: [{ id: "settings", rootPath: "/settings" }], topLevelPaths: [] }}
        >
          <Probe />
          <StackScreenContext.Provider value="settings:2">
            <SpendingBackLink />
          </StackScreenContext.Provider>
        </MobileStackProvider>
      </MemoryRouter>,
    );
    act(() => void navigate("/settings/spending"));
    act(() => void navigate("/settings/spending/rules"));
    expect(settingsStack).toEqual(["/settings", "/settings/spending", "/settings/spending/rules"]);

    act(() => void fireEvent.click(screen.getByRole("link")));
    expect(pathname).toBe("/settings/spending");
    expect(settingsStack).toEqual(["/settings", "/settings/spending"]);
  });

  it("opens Spending outside the phone stack", () => {
    render(
      <MemoryRouter initialEntries={["/settings/spending/rules"]}>
        <Probe />
        <SpendingBackLink />
      </MemoryRouter>,
    );
    act(() => void fireEvent.click(screen.getByRole("link")));
    expect(pathname).toBe("/settings/spending");
  });
});
