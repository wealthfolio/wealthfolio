import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
