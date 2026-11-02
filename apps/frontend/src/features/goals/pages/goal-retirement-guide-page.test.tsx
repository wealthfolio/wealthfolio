import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { StackScreenContext } from "@/pages/layouts/mobile-stack/mobile-stack-contexts";
import { MobileStackProvider } from "@/pages/layouts/mobile-stack/mobile-stack-provider";
import { useMobileStack } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import GoalRetirementGuidePage from "./goal-retirement-guide-page";

vi.mock("@/adapters", () => ({
  listenBackButton: () => Promise.resolve(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isAndroid: false, isTauri: false }),
}));
vi.mock("@/lib/settings-provider", () => ({ useSettingsContext: () => ({ settings: {} }) }));
vi.mock("@/features/goals/retirement-planner/pages/guide-page", () => ({
  default: () => <p>Guide</p>,
}));

let navigate: ReturnType<typeof useNavigate> = () => undefined;
let goalsStack: string[] = [];

function Probe() {
  navigate = useNavigate();
  goalsStack =
    useMobileStack()?.state.stacks.goals?.map((screen) => screen.location.pathname) ?? [];
  return null;
}

describe("the retirement guide's back button", () => {
  it("returns to the goal underneath instead of opening it again", () => {
    render(
      <MemoryRouter initialEntries={["/goals"]}>
        <MobileStackProvider
          config={{ tabs: [{ id: "goals", rootPath: "/goals" }], topLevelPaths: ["/goals"] }}
        >
          <Probe />
          <StackScreenContext.Provider value="goals:2">
            <Routes>
              <Route path="/goals/:goalId/guide" element={<GoalRetirementGuidePage />} />
              <Route path="*" element={null} />
            </Routes>
          </StackScreenContext.Provider>
        </MobileStackProvider>
      </MemoryRouter>,
    );
    act(() => void navigate("/goals/g1"));
    act(() => void navigate("/goals/g1/guide"));
    expect(goalsStack).toEqual(["/goals", "/goals/g1", "/goals/g1/guide"]);

    act(() => void fireEvent.click(screen.getByRole("button", { name: /back/i })));
    expect(goalsStack).toEqual(["/goals", "/goals/g1"]);
  });
});
