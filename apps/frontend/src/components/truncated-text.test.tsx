import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@wealthfolio/ui";

import { TRUNCATED_TEXT_TOOLTIP_MAX_CHARS, TruncatedText } from "./truncated-text";
import { findTooltip, queryTooltip } from "@/test/tooltip";

/** jsdom does no layout, so overflow is whatever the test says it is. */
function setOverflow(el: HTMLElement, overflowing: boolean) {
  Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: overflowing ? 500 : 100, configurable: true });
}

function renderText(text: string) {
  render(
    <TooltipProvider delay={0}>
      <TruncatedText text={text} data-testid="text" />
    </TooltipProvider>,
  );
  return screen.getByTestId("text");
}

describe("TruncatedText", () => {
  it("shows the full text in a tooltip only when the text overflows", async () => {
    const user = userEvent.setup();
    const el = renderText("a long note");
    setOverflow(el, true);

    await user.hover(el);

    expect(await findTooltip()).toHaveTextContent("a long note");
  });

  it("stays quiet when the text fits", async () => {
    const user = userEvent.setup();
    const el = renderText("short");
    setOverflow(el, false);

    await user.hover(el);

    expect(queryTooltip()).not.toBeInTheDocument();
  });

  it("caps the tooltip itself", async () => {
    const user = userEvent.setup();
    const text = "x".repeat(TRUNCATED_TEXT_TOOLTIP_MAX_CHARS + 50);
    const el = renderText(text);
    setOverflow(el, true);

    await user.hover(el);

    const tooltip = await findTooltip();
    expect(tooltip.textContent).toHaveLength(TRUNCATED_TEXT_TOOLTIP_MAX_CHARS + 1);
    expect(tooltip.textContent?.endsWith("…")).toBe(true);
  });
});
