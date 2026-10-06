import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./page-error-boundary";

function Broken(): never {
  throw new Error("page failed");
}

const app = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <nav>Sidebar</nav>
      <PageErrorBoundary>
        <Routes>
          <Route path="/" element={<p>Dashboard page</p>} />
          <Route path="/dashboard" element={<Broken />} />
          <Route path="/health" element={<Broken />} />
        </Routes>
      </PageErrorBoundary>
    </MemoryRouter>,
  );

describe("a page that fails to render", () => {
  beforeEach(() => {
    // React reports the caught error; the boundary handles it.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("leaves navigation usable and offers a way back to the dashboard", () => {
    app("/health");
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));
    // The next route starts afresh.
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no way to the dashboard from the dashboard itself", () => {
    app("/dashboard");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Dashboard" })).toBeNull();
  });
});
