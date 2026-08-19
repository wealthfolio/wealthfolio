import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { AmountInput } from "../amount-input";

interface FormValues {
  unitPrice?: number;
}

interface TestFormProps {
  currency?: string;
  dataTestId?: string;
  label?: string;
  locale?: string;
  maxDecimalPlaces?: number;
}

function TestForm({
  currency,
  dataTestId,
  label,
  locale = "en-US",
  maxDecimalPlaces,
}: TestFormProps) {
  const form = useForm<FormValues>({ defaultValues: { unitPrice: undefined } });
  const value = form.watch("unitPrice");

  return (
    <FormattingProvider locale={locale}>
      <FormProvider {...form}>
        <AmountInput<FormValues>
          name="unitPrice"
          label={label}
          currency={currency}
          data-testid={dataTestId}
          maxDecimalPlaces={maxDecimalPlaces}
        />
        <output aria-label="form value">{value === undefined ? "undefined" : value}</output>
        <button
          type="button"
          onClick={() => form.setError("unitPrice", { message: "Amount is required" })}
        >
          Validate
        </button>
      </FormProvider>
    </FormattingProvider>
  );
}

describe("activity AmountInput field", () => {
  it("writes locale-aware pasted amounts into React Hook Form", async () => {
    render(<TestForm locale="de-DE" currency="EUR" />);

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Amount" });
    fireEvent.paste(input, {
      clipboardData: { getData: () => "1.234,56 €" },
    });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "form value" })).toHaveTextContent("1234.56"),
    );
    expect(input).toHaveValue("1234,56");
    expect(input).toHaveAttribute("name", "unitPrice");
    expect(input).toHaveAttribute("data-testid", "unit-price-input");
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("localizes its default placeholder and accepts common machine-formatted currency paste", async () => {
    render(<TestForm locale="fr-FR" currency="CAD" />);

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Amount" });
    expect(input).toHaveAttribute("placeholder", "0,00");

    fireEvent.paste(input, {
      clipboardData: { getData: () => "$1,234.56" },
    });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "form value" })).toHaveTextContent("1234.56"),
    );
    expect(input).toHaveValue("1234,56");
  });

  it("forwards custom labels, test IDs, and decimal precision", async () => {
    const user = userEvent.setup();
    render(<TestForm label="Unit price" dataTestId="custom-price" maxDecimalPlaces={3} />);

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Unit price" });
    await user.type(input, "12.3456");

    expect(input).toHaveAttribute("data-testid", "custom-price");
    expect(input).toHaveValue("12.345");
    expect(screen.getByRole("status", { name: "form value" })).toHaveTextContent("12.345");
  });

  it("renders React Hook Form validation errors on the input", async () => {
    const user = userEvent.setup();
    render(<TestForm currency="USD" />);

    await user.click(screen.getByRole("button", { name: "Validate" }));

    const message = await screen.findByText("Amount is required");
    const input = screen.getByRole("textbox", { name: "Amount" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(message.id);
    expect(screen.getByText("Amount")).toHaveAttribute("for", input.id);
  });
});
