import { act, render } from "@testing-library/react";
import { BrowserRouter, useLocation, useNavigate, type Location } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { readHistoryIndex } from "./history-index";

// The phone stack reads the history position React Router keeps in each entry's
// state. It is not public API, so this pins it down: an upgrade that stops
// writing it fails here instead of quietly breaking back navigation.
describe("React Router's history position", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("is written for every entry and read back for the location shown", () => {
    window.history.replaceState(null, "", "/holdings");
    const seen: { location: Location; index: number | null }[] = [];
    let navigate: ReturnType<typeof useNavigate> = () => undefined;

    function Probe() {
      const location = useLocation();
      navigate = useNavigate();
      seen.push({ location, index: readHistoryIndex(location) });
      return null;
    }

    render(
      <BrowserRouter>
        <Probe />
      </BrowserRouter>,
    );
    act(() => void navigate("/holdings/AMD"));
    act(() => void navigate("/holdings/AMD?tab=history", { replace: true }));
    act(() => void navigate("/settings"));

    const last = (pathname: string) =>
      [...seen].reverse().find((entry) => entry.location.pathname === pathname);
    expect(last("/holdings")?.index).toBe(0);
    expect(last("/holdings/AMD")?.index).toBe(1);
    expect(last("/settings")?.index).toBe(2);
    expect(window.history.state).toMatchObject({ idx: 2, key: last("/settings")?.location.key });
  });

  it("is not trusted for a location other than the current entry", () => {
    window.history.replaceState({ idx: 4, key: "other" }, "", "/holdings");
    const location = { pathname: "/holdings", search: "", hash: "", state: null, key: "mine" };
    expect(readHistoryIndex(location)).toBeNull();
  });
});
