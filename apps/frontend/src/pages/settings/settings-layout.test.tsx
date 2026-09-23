import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import SettingsLayout from "./settings-layout";

const initialWidth = window.innerWidth;
let mounts = 0;

function CountingPage() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="settings-page" />;
}

function renderAt(path: string, width: number) {
  window.innerWidth = width;
  mounts = 0;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<CountingPage />} />
          <Route path="connect" element={<CountingPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.innerWidth = initialWidth;
});

describe("SettingsLayout", () => {
  // Regression: a second, CSS-hidden copy of the page opened its dialogs twice.
  it.each([
    ["desktop", 1280],
    ["phone", 390],
  ])("mounts a settings page once on %s", (_, width) => {
    renderAt("/settings/connect", width);

    expect(screen.getAllByTestId("settings-page")).toHaveLength(1);
    expect(mounts).toBe(1);
  });

  it("keeps the page mounted when the window crosses the breakpoint", () => {
    renderAt("/settings/connect", 1280);

    act(() => {
      window.innerWidth = 390;
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getAllByTestId("settings-page")).toHaveLength(1);
    expect(mounts).toBe(1);
  });

  it("shows the settings list instead of the index page on phones", () => {
    renderAt("/settings", 390);

    expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument();
    expect(mounts).toBe(0);
  });
});
