import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { QuantityInput } from "../quantity-input";

interface FormValues {
  quantity?: number;
}

interface TestFormProps {
  allowNegative?: boolean;
  dataTestId?: string;
  label?: string;
  locale?: string;
  maxDecimalPlaces?: number;
}

function TestForm({
  allowNegative,
  dataTestId,
  label,
  locale = "en-US",
  maxDecimalPlaces,
}: TestFormProps) {
  const form = useForm<FormValues>({ defaultValues: { quantity: undefined } });
  const value = form.watch("quantity");

  return (
    <FormattingProvider locale={locale}>
      <FormProvider {...form}>
        <QuantityInput<FormValues>
          name="quantity"
          label={label}
          allowNegative={allowNegative}
          data-testid={dataTestId}
          maxDecimalPlaces={maxDecimalPlaces}
        />
        <output aria-label="form value">{value === undefined ? "undefined" : value}</output>
        <button
          type="button"
          onClick={() => form.setError("quantity", { message: "Quantity is required" })}
        >
          Validate
        </button>
      </FormProvider>
    </FormattingProvider>
  );
}

describe("activity QuantityInput field", () => {
  it("writes locale-aware pasted quantities into React Hook Form", async () => {
    render(<TestForm locale="de-DE" />);

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Quantity" });
    fireEvent.paste(input, {
      clipboardData: { getData: () => "1.234,5678" },
    });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "form value" })).toHaveTextContent("1234.5678"),
    );
    expect(input).toHaveValue("1.234,5678");
    expect(input).toHaveAttribute("name", "quantity");
    expect(input).toHaveAttribute("data-testid", "quantity-input");
  });

  it("localizes its default placeholder", () => {
    render(<TestForm locale="fr-FR" />);

    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveAttribute(
      "placeholder",
      "0,00",
    );
  });

  it("forwards negative-value support and decimal precision", async () => {
    const user = userEvent.setup();
    render(
      <TestForm
        locale="de-DE"
        label="Units"
        dataTestId="custom-quantity"
        allowNegative
        maxDecimalPlaces={3}
      />,
    );

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Units" });
    await user.type(input, "-12,3456");

    expect(input).toHaveAttribute("data-testid", "custom-quantity");
    expect(input).toHaveValue("-12,345");
    expect(screen.getByRole("status", { name: "form value" })).toHaveTextContent("-12.345");
  });

  it("renders React Hook Form validation errors on the input", async () => {
    const user = userEvent.setup();
    render(<TestForm />);

    await user.click(screen.getByRole("button", { name: "Validate" }));

    const message = await screen.findByText("Quantity is required");
    const input = screen.getByRole("textbox", { name: "Quantity" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(message.id);
    expect(screen.getByText("Quantity")).toHaveAttribute("for", input.id);
  });
});
