import { render } from "@testing-library/react";
import { useRef } from "react";
import { expect, it } from "vitest";
import { useKeptScrollPositions } from "./use-kept-scroll-positions";

function Layer({ visible }: { visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeptScrollPositions(ref, visible);
  return (
    <div ref={ref} style={visible ? undefined : { display: "none" }}>
      <div data-testid="pane" />
    </div>
  );
}

/** jsdom keeps no scroll offsets; give the pane one that a test can move. */
function scrollable(element: HTMLElement) {
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return {
    scrollTo(value: number) {
      top = value;
      element.dispatchEvent(new Event("scroll"));
    },
    // What WebKit does to a box under `display: none`: the offset drops to 0.
    reset() {
      top = 0;
    },
  };
}

it("puts a kept screen's scroll offset back when it is shown again", () => {
  const { getByTestId, rerender } = render(<Layer visible />);
  const pane = getByTestId("pane");
  const scroll = scrollable(pane);

  scroll.scrollTo(1034);
  rerender(<Layer visible={false} />);
  scroll.reset();
  rerender(<Layer visible />);

  expect(pane.scrollTop).toBe(1034);
});

it("ignores scroll events that arrive while the screen is hidden", () => {
  const { getByTestId, rerender } = render(<Layer visible />);
  const pane = getByTestId("pane");
  const scroll = scrollable(pane);

  scroll.scrollTo(400);
  rerender(<Layer visible={false} />);
  scroll.scrollTo(0);
  rerender(<Layer visible />);

  expect(pane.scrollTop).toBe(400);
});

it("keeps a scroll made while visible, such as scrolling back to the top", () => {
  const { getByTestId, rerender } = render(<Layer visible />);
  const pane = getByTestId("pane");
  const scroll = scrollable(pane);

  scroll.scrollTo(600);
  scroll.scrollTo(0);
  rerender(<Layer visible={false} />);
  rerender(<Layer visible />);

  expect(pane.scrollTop).toBe(0);
});
