import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { FormattingProvider, useNumberFormatting } from "@wealthfolio/ui";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { GoalLeverRow } from "./goal-lever-row";

function renderRateLever(value: number, onChange: (value: number) => void) {
  render(
    <GoalLeverRow
      label="Fund return"
      value={value}
      onChange={onChange}
      min={-0.2}
      max={0.15}
      inputMax={0.5}
      step={0.001}
      suffix="%"
      format={(next) => (next * 100).toFixed(1)}
    />,
  );
}

describe("GoalLeverRow number input", () => {
  it("does not commit an untouched negative value on blur", () => {
    const onChange = vi.fn();
    renderRateLever(-0.006, onChange);

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits a negative value after the user edits it", () => {
    const onChange = vi.fn();
    renderRateLever(-0.006, onChange);

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "-2.0" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(-0.02);
  });

  it("treats a comma as the decimal separator", () => {
    const onChange = vi.fn();
    renderRateLever(-0.006, onChange);

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "-2,0" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(-0.02);
  });
});

function LocalizedRateLever({ onChange }: { onChange: (value: number) => void }) {
  const numbers = useNumberFormatting();
  return (
    <GoalLeverRow
      label="Return"
      value={0.058}
      onChange={onChange}
      min={-0.2}
      max={0.5}
      step={0.001}
      suffix="%"
      format={(value) =>
        numbers.formatDecimal(value * 100, {
          maximumFractionDigits: 1,
          useGrouping: false,
        })
      }
    />
  );
}

it("commits an in-place edit of an RTL localized return", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <DirectionProvider direction="rtl">
      <FormattingProvider locale="ES">
        <LocalizedRateLever onChange={onChange} />
      </FormattingProvider>
    </DirectionProvider>,
  );
  const input = screen.getByRole("textbox");
  await user.click(input);
  await user.keyboard("{End}{Backspace}9{Tab}");
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange.mock.calls[0][0]).toBeCloseTo(0.059);
  expect(input).toHaveValue("5,8");
});

it("parses localized digits and rejects malformed drafts", () => {
  const onChange = vi.fn();
  render(
    <FormattingProvider locale="ar-EG">
      <LocalizedRateLever onChange={onChange} />
    </FormattingProvider>,
  );
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "٩٫٥" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith(0.095);
  onChange.mockClear();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "9bad" } });
  fireEvent.blur(input);
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps the existing lever value when its draft is empty", () => {
  const onChange = vi.fn();
  renderRateLever(0.058, onChange);
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(onChange).not.toHaveBeenCalled();
  expect(input).toHaveValue("5.8");
});
