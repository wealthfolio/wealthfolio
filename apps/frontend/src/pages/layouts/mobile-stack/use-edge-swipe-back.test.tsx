import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  shouldCommitSwipe,
  useEdgeSwipeBack,
  type EdgeSwipeBackOptions,
} from "./use-edge-swipe-back";

describe("releasing a back swipe", () => {
  it("goes back past 40% of the width, or on a quick flick", () => {
    expect(shouldCommitSwipe(0.6, 0)).toBe(true);
    expect(shouldCommitSwipe(0.2, 0.5)).toBe(true);
    expect(shouldCommitSwipe(0.3, 0.1)).toBe(false);
  });

  it("stays when the finger is moving back toward the edge, however far it went", () => {
    expect(shouldCommitSwipe(0.6, -0.5)).toBe(false);
    expect(shouldCommitSwipe(0.9, -0.2)).toBe(false);
  });

  it("still goes back when the finger only drifts as it lifts", () => {
    expect(shouldCommitSwipe(0.6, -0.05)).toBe(true);
  });
});

function Harness(props: EdgeSwipeBackOptions & { inside: React.ReactNode }) {
  const { inside, ...options } = props;
  const handlers = useEdgeSwipeBack(options);
  return (
    <div data-testid="container" {...handlers}>
      {inside}
    </div>
  );
}

function renderSwipe(inside: React.ReactNode) {
  const onStart = vi.fn();
  const onRelease = vi.fn();
  const utils = render(
    <Harness
      direction="ltr"
      enabled
      onStart={onStart}
      onProgress={() => undefined}
      onRelease={onRelease}
      inside={inside}
    />,
  );
  const container = utils.getByTestId("container");
  container.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
  container.setPointerCapture = () => undefined;
  return { ...utils, container, onStart, onRelease };
}

/** A touch that starts at the left edge on `target` and moves 100px right. */
function edgeDrag(target: Element) {
  const pointer = { pointerId: 1, isPrimary: true, pointerType: "touch" };
  fireEvent.pointerDown(target, { ...pointer, clientX: 5, clientY: 400 });
  fireEvent.pointerMove(target, { ...pointer, clientX: 105, clientY: 400 });
  fireEvent.pointerUp(target, { ...pointer, clientX: 105, clientY: 400 });
}

describe("where a back swipe can start", () => {
  it("starts on the screen's content at the edge", () => {
    const { getByText, onStart } = renderSwipe(<p>Row</p>);
    edgeDrag(getByText("Row"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("leaves elements that drag sideways themselves alone", () => {
    const { getByText, onStart } = renderSwipe(
      <div data-no-swipe-drag>
        <p>Chart</p>
      </div>,
    );
    edgeDrag(getByText("Chart"));
    expect(onStart).not.toHaveBeenCalled();
  });

  it("leaves popups opened from the screen alone", async () => {
    const { createPortal } = await import("react-dom");
    const { getByText, onStart } = renderSwipe(createPortal(<p>Sheet row</p>, document.body));
    edgeDrag(getByText("Sheet row"));
    expect(onStart).not.toHaveBeenCalled();
  });

  it("settles a swipe whose touch end never arrived when the next touch starts", () => {
    const { getByText, onRelease } = renderSwipe(<p>Row</p>);
    const pointer = { pointerId: 1, isPrimary: true, pointerType: "touch" };
    fireEvent.pointerDown(getByText("Row"), { ...pointer, clientX: 5, clientY: 400 });
    fireEvent.pointerMove(getByText("Row"), { ...pointer, clientX: 105, clientY: 400 });
    fireEvent.pointerDown(getByText("Row"), {
      ...pointer,
      pointerId: 2,
      clientX: 200,
      clientY: 400,
    });
    expect(onRelease).toHaveBeenCalledWith(false, expect.any(Number));
  });
});
