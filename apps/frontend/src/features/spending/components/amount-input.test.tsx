import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

import { AmountInput } from "./amount-input";

describe("spending AmountInput", () => {
  it("defers a normalized commit until blur", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<AmountInput value={12.5} onCommit={onCommit} />);

    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.clear(input);
    await user.type(input, "15.250");

    expect(onCommit).not.toHaveBeenCalled();

    await user.tab();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("15.25");
  });

  it("commits through Enter by blurring the field", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<AmountInput value={10} onCommit={onCommit} />);

    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.clear(input);
    await user.type(input, "7.5{Enter}");

    expect(input).not.toHaveFocus();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("7.5");
  });

  it("renders and commits locale-native decimal input", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <FormattingProvider locale="fr-FR">
        <AmountInput value={12.5} onCommit={onCommit} />
      </FormattingProvider>,
    );

    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input).toHaveValue("12,5");

    await user.clear(input);
    await user.type(input, "15,25");
    await user.tab();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("15.25");
  });

  it("commits machine-formatted currency paste under a comma-decimal locale", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <FormattingProvider locale="fr-FR">
        <AmountInput value={0} onCommit={onCommit} />
      </FormattingProvider>,
    );

    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.click(input);
    await user.paste("$1,234.56");
    await user.tab();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("1234.56");
  });

  it("does not commit unchanged or invalid drafts", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<AmountInput value={12.5} onCommit={onCommit} />);

    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.click(input);
    await user.tab();

    await user.click(input);
    await user.clear(input);
    await user.type(input, "invalid");
    await user.tab();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("syncs external values only while the field is not being edited", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<AmountInput value={10} onCommit={onCommit} />);

    const input = screen.getByRole<HTMLInputElement>("textbox");
    rerender(<AmountInput value={20} onCommit={onCommit} />);
    expect(input).toHaveValue("20");

    await user.click(input);
    await user.clear(input);
    await user.type(input, "30");
    rerender(<AmountInput value={40} onCommit={onCommit} />);

    expect(input).toHaveValue("30");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("renders zero as an empty dashed input and honors the dashed variant", () => {
    const { container, rerender } = render(<AmountInput value={0} onCommit={vi.fn()} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(container.firstElementChild).toHaveClass("border-dashed");

    rerender(<AmountInput value={25} onCommit={vi.fn()} variant="dashed" />);

    expect(screen.getByRole("textbox")).toHaveValue("25");
    expect(container.firstElementChild).toHaveClass("border-dashed");
  });
});
