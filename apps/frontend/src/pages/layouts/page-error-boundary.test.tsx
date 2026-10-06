import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./page-error-boundary";

function Broken(): never {
  throw new Error("page failed");
}

/** A page whose `?tab=broken` view fails, as a query-driven view can. */
function Page({ name }: { name: string }) {
  const [params] = useSearchParams();
  if (params.get("tab") === "broken") throw new Error("view failed");
  return <p>{name} page</p>;
}

const app = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <nav>
        Sidebar <Link to="/holdings">Holdings link</Link>
      </nav>
      <PageErrorBoundary>
        <Routes>
          <Route path="/" element={<Page name="Dashboard" />} />
          <Route path="/dashboard" element={<Broken />} />
          <Route path="/health" element={<Broken />} />
          <Route path="/holdings" element={<Page name="Holdings" />} />
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
    expect(screen.getByText(/Sidebar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));
    // The next route starts afresh.
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers when navigation changes only the query", () => {
    app("/holdings?tab=broken");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Holdings link" }));
    expect(screen.getByText("Holdings page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the plain dashboard from a dashboard view that fails", () => {
    app("/?tab=broken");
    fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
  });

  it("offers no way to the dashboard from the dashboard itself", () => {
    app("/dashboard");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Dashboard" })).toBeNull();
  });
});
