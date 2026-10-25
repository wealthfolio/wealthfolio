import { act, render } from "@testing-library/react";
import { Activity, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { StageNav, type InsightsStage } from "./stage-nav";

const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;
afterEach(() => scrollIntoView.mockClear());

it("scrolls to the stage when it changes, not when its phone screen is shown again", () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: its effects run again when it is shown, and the page
  // keeps the scroll it was left with.
  let setHidden: (hidden: boolean) => void = () => undefined;
  let setStage: (stage: InsightsStage) => void = () => undefined;
  function Report() {
    const [hidden, setHiddenState] = useState(false);
    const [stage, setStageState] = useState<InsightsStage>("where");
    setHidden = setHiddenState;
    setStage = setStageState;
    return (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <StageNav stage={stage} onStageChange={setStageState} />
      </Activity>
    );
  }
  render(<Report />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);

  act(() => setHidden(true));
  act(() => setHidden(false));
  expect(scrollIntoView).toHaveBeenCalledTimes(1);

  act(() => setStage("when"));
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
});
