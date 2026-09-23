import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FlowFrame, FlowScreen } from "./flow-layout";

// Review finding: every step had its own height and layout, so the setup
// dialog kept changing size. The frame has one size and every step fills it.
it("keeps one frame size on desktop and fills the sheet on phones", () => {
  const { container, rerender } = render(
    <FlowFrame>
      <p>step</p>
    </FlowFrame>,
  );
  expect(container.firstElementChild).toHaveClass("min-h-[544px]");

  rerender(
    <FlowFrame fill>
      <p>step</p>
    </FlowFrame>,
  );
  expect(container.firstElementChild).toHaveClass("flex-1");
  expect(container.firstElementChild).not.toHaveClass("min-h-[544px]");
});

it("pins actions and the footnote to the bottom of the frame", () => {
  render(
    <FlowScreen
      title="Transferring your data"
      footnote="End-to-end encrypted."
      actions={<button type="button">Cancel</button>}
    />,
  );
  const footer = screen.getByRole("button", { name: "Cancel" }).parentElement;
  expect(footer).toHaveClass("mt-auto");
  expect(footer).toHaveTextContent("End-to-end encrypted.");
});
