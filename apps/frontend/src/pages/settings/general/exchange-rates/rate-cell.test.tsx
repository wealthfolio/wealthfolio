import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { expect, it, vi } from "vitest";
import { RateCell } from "./rate-cell";

it("uses the selected region when displaying and editing exchange rates", () => {
  const onUpdate = vi.fn();
  render(
    <FormattingProvider locale="ES">
      <RateCell
        rate={{
          id: "USD_EUR",
          fromCurrency: "USD",
          toCurrency: "EUR",
          rate: 1.2345,
          source: "MANUAL",
          timestamp: "2026-11-02",
        }}
        onUpdate={onUpdate}
      />
    </FormattingProvider>,
  );
  expect(screen.getByText("1,2345")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /edit/i }));
  const input = screen.getByRole("textbox");
  expect(input).toHaveValue("1,2345");
  fireEvent.change(input, { target: { value: "1,5678" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ rate: 1.5678 }));
});

it("preserves an edited rate across a region change before saving", () => {
  const onUpdate = vi.fn();
  const cell = (locale: string) => (
    <FormattingProvider locale={locale}>
      <RateCell
        rate={{
          id: "USD_EUR",
          fromCurrency: "USD",
          toCurrency: "EUR",
          rate: 1.234,
          source: "MANUAL",
          timestamp: "2026-11-02",
        }}
        onUpdate={onUpdate}
      />
    </FormattingProvider>
  );
  const { rerender } = render(cell("ES"));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "1,235" } });
  rerender(cell("US"));
  expect(screen.getByRole("textbox")).toHaveValue("1.235");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ rate: 1.235 }));
});

it("rejects an empty exchange-rate draft without saving zero", () => {
  const onUpdate = vi.fn();
  render(
    <FormattingProvider locale="ES">
      <RateCell
        rate={{
          id: "USD_EUR",
          fromCurrency: "USD",
          toCurrency: "EUR",
          rate: 1.234,
          source: "MANUAL",
          timestamp: "2026-11-02",
        }}
        onUpdate={onUpdate}
      />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onUpdate).not.toHaveBeenCalled();
  expect(input).toHaveValue("");
});

it("saves an edited rate on Enter", () => {
  const onUpdate = vi.fn();
  render(
    <FormattingProvider locale="FR">
      <RateCell
        rate={{
          id: "USD_EUR",
          fromCurrency: "USD",
          toCurrency: "EUR",
          rate: 1.234,
          source: "MANUAL",
          timestamp: "2026-11-02",
        }}
        onUpdate={onUpdate}
      />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "0,9876" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ rate: 0.9876 }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
