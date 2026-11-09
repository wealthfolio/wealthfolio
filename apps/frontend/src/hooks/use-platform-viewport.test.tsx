import { act, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Activity, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { useClipsFlexOverflow, useIsMobileViewport } from "./use-platform";

const portraitWidth = window.innerWidth;
const setWidth = (width: number) =>
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
afterEach(() => setWidth(portraitWidth));

it("lays out for a rotation made while its phone screen was out of sight", () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: it misses resizes until it is shown again.
  let setHidden: (hidden: boolean) => void = () => undefined;
  function Layout() {
    return <output>{useIsMobileViewport() ? "phone" : "wide"}</output>;
  }
  function KeptScreen() {
    const [hidden, setHiddenState] = useState(false);
    setHidden = setHiddenState;
    return (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <Layout />
      </Activity>
    );
  }
  setWidth(390);
  render(<KeptScreen />);
  expect(screen.getByRole("status")).toHaveTextContent("phone");

  act(() => setHidden(true));
  setWidth(844);
  act(() => void window.dispatchEvent(new Event("resize")));
  act(() => setHidden(false));

  expect(screen.getByRole("status")).toHaveTextContent("wide");
});

it("knows the widths at which globals.css clips the overflow of flex boxes", () => {
  // Charts keep their tooltips inside where this rule would cut them off (#2161).
  const css = readFileSync(join(import.meta.dirname, "../globals.css"), "utf8");
  const rule =
    /@media \(max-width: (\d+)px\) \{(?:(?!@media)[\s\S])*?\.flex \{[^}]*overflow-x: hidden/.exec(
      css,
    );
  expect(rule).not.toBeNull();
  const maxWidth = Number(rule?.[1]);

  setWidth(maxWidth);
  expect(renderHook(() => useClipsFlexOverflow()).result.current).toBe(true);
  setWidth(maxWidth + 1);
  expect(renderHook(() => useClipsFlexOverflow()).result.current).toBe(false);
});
