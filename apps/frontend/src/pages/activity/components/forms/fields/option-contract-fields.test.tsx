import { resolveSymbolQuote } from "@/adapters";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { act, render, screen, waitFor } from "@/test/render";
import { zodResolver } from "@hookform/resolvers/zod";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm, useWatch, type Resolver } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { buyFormSchema, type BuyFormValues } from "../buy-form";
import { OptionContractFields } from "./option-contract-fields";

vi.mock("@/adapters", () => ({
  resolveSymbolQuote: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/components/ticker-search", () => ({
  default: ({
    value,
    onSelectResult,
  }: {
    value?: string;
    onSelectResult: (symbol: string) => void;
  }) => (
    <>
      <input aria-label="Option underlying" value={value ?? ""} readOnly />
      <button type="button" onClick={() => onSelectResult("MSFT280121P00200000")}>
        Select option contract
      </button>
    </>
  ),
}));

function OptionContractTestForm({
  defaultExpirationDate,
  defaultUnitPrice = 5,
  defaultCurrency = "USD",
  defaultQuoteCcy,
  defaultStrikePrice = 150,
  onSubmit = () => undefined,
}: {
  defaultExpirationDate?: string;
  defaultUnitPrice?: number;
  defaultCurrency?: string;
  defaultQuoteCcy?: string;
  defaultStrikePrice?: number;
  onSubmit?: (values: BuyFormValues) => void;
}) {
  const form = useForm<BuyFormValues>({
    resolver: zodResolver(buyFormSchema) as Resolver<BuyFormValues>,
    defaultValues: {
      assetType: "option",
      accountId: "account-1",
      assetId: "",
      activityDate: new Date("2026-09-15T00:00:00Z"),
      quantity: 1,
      unitPrice: defaultUnitPrice,
      fee: 0,
      tax: 0,
      currency: defaultCurrency,
      symbolQuoteCcy: defaultQuoteCcy,
      underlyingSymbol: "AAPL",
      strikePrice: defaultStrikePrice,
      expirationDate: defaultExpirationDate,
      optionType: "CALL",
      contractMultiplier: 100,
      subtype: ACTIVITY_SUBTYPES.POSITION_OPEN,
    },
  });
  const expirationDate = useWatch({
    control: form.control,
    name: "expirationDate",
  });

  const unitPrice = useWatch({ control: form.control, name: "unitPrice" });

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <OptionContractFields
          underlyingName="underlyingSymbol"
          strikePriceName="strikePrice"
          expirationDateName="expirationDate"
          optionTypeName="optionType"
          currencyName="currency"
          quoteCcyName="symbolQuoteCcy"
          unitPriceName="unitPrice"
        />
        <output data-testid="unit-price">{unitPrice}</output>
        <output data-testid="expiration-value">{expirationDate ?? ""}</output>
        <button
          type="button"
          onClick={() =>
            form.reset({
              ...form.getValues(),
              expirationDate: "2030-06-15",
            })
          }
        >
          Reset expiration
        </button>
        <button
          type="button"
          onClick={() =>
            form.reset({
              ...form.getValues(),
              expirationDate: "",
            })
          }
        >
          Clear expiration
        </button>
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

describe("OptionContractFields", () => {
  it("commits the expiration date when the year is entered first", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OptionContractTestForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("2027");
    await user.click(screen.getByRole("spinbutton", { name: /month/i }));
    await user.keyboard("12");
    await user.click(screen.getByRole("spinbutton", { name: /day/i }));
    await user.keyboard("31");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-31");
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it("preserves month and day when they are entered before the year", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OptionContractTestForm onSubmit={onSubmit} />);

    const month = screen.getByRole("spinbutton", { name: /month/i });
    const day = screen.getByRole("spinbutton", { name: /day/i });
    const year = screen.getByRole("spinbutton", { name: /year/i });

    await user.click(month);
    await user.keyboard("12");
    expect(month).toHaveAttribute("aria-valuenow", "12");

    await user.click(day);
    await user.keyboard("31");
    expect(month).toHaveAttribute("aria-valuenow", "12");
    expect(day).toHaveAttribute("aria-valuenow", "31");

    await user.click(year);
    expect(month).toHaveAttribute("aria-valuenow", "12");
    expect(day).toHaveAttribute("aria-valuenow", "31");
    await user.keyboard("2");
    expect(month).toHaveAttribute("aria-valuenow", "12");
    expect(day).toHaveAttribute("aria-valuenow", "31");
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("0002-12-31");

    await user.keyboard("027");
    expect(year).toHaveAttribute("aria-valuenow", "2027");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-31");
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].expirationDate).toBe("2027-12-31");
  });

  it("keeps an intermediate expiration year editable", async () => {
    const user = userEvent.setup();
    render(<OptionContractTestForm />);

    await user.click(screen.getByRole("spinbutton", { name: /month/i }));
    await user.keyboard("12");
    await user.click(screen.getByRole("spinbutton", { name: /day/i }));
    await user.keyboard("31");
    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("999");
    await user.tab();

    expect(screen.getByRole("spinbutton", { name: /year/i })).toHaveAttribute(
      "aria-valuenow",
      "999",
    );
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("0999-12-31");
  });

  it("replaces an intermediate year when the form loads a different date", async () => {
    const user = userEvent.setup();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" />);

    const year = screen.getByRole("spinbutton", { name: /year/i });
    await user.click(year);
    await user.keyboard("999");
    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: /year/i })).toHaveAttribute(
        "aria-valuenow",
        "999",
      );
      expect(screen.getByTestId("expiration-value")).toHaveTextContent("0999-12-31");
    });

    await user.click(screen.getByRole("button", { name: "Reset expiration" }));

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toHaveTextContent("2030-06-15");
      expect(screen.getByRole("spinbutton", { name: /year/i })).toHaveAttribute(
        "aria-valuenow",
        "2030",
      );
      expect(screen.getByRole("spinbutton", { name: /month/i })).toHaveAttribute(
        "aria-valuenow",
        "6",
      );
      expect(screen.getByRole("spinbutton", { name: /day/i })).toHaveAttribute(
        "aria-valuenow",
        "15",
      );
    });

    await user.click(screen.getByRole("button", { name: "Clear expiration" }));

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
      expect(screen.getByRole("spinbutton", { name: /year/i })).not.toHaveAttribute(
        "aria-valuenow",
      );
    });
  });

  it("does not submit a stale existing expiration while the edited year is incomplete", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("999");
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("0999-12-31");

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a valid expiration date.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears an existing expiration date when the form resets", async () => {
    const user = userEvent.setup();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" />);

    expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-31");
    await user.click(screen.getByRole("button", { name: "Clear expiration" }));

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
      expect(screen.getByRole("spinbutton", { name: /year/i })).not.toHaveAttribute(
        "aria-valuenow",
      );
      expect(screen.getByRole("spinbutton", { name: /month/i })).not.toHaveAttribute(
        "aria-valuenow",
      );
      expect(screen.getByRole("spinbutton", { name: /day/i })).not.toHaveAttribute("aria-valuenow");
    });
  });

  it("clears an intermediate year when resetting to empty", async () => {
    const user = userEvent.setup();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" />);
    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("999");
    await user.click(screen.getByRole("button", { name: "Clear expiration" }));
    expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
    for (const name of [/year/i, /month/i, /day/i]) {
      expect(screen.getByRole("spinbutton", { name })).not.toHaveAttribute("aria-valuenow");
    }
  });

  it("does not resolve or summarize an intermediate expiration", async () => {
    const user = userEvent.setup();
    vi.mocked(resolveSymbolQuote).mockClear();
    render(<OptionContractTestForm />);
    await user.click(screen.getByRole("spinbutton", { name: /month/i }));
    await user.keyboard("12");
    await user.click(screen.getByRole("spinbutton", { name: /day/i }));
    await user.keyboard("31");
    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("999");
    expect(resolveSymbolQuote).not.toHaveBeenCalled();
    expect(screen.queryByText("Contract", { exact: true })).not.toBeInTheDocument();
  });

  it("clears the form value when all date segments are erased", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" onSubmit={onSubmit} />);
    for (const name of [/month/i, /day/i, /year/i]) {
      await user.click(screen.getByRole("spinbutton", { name }));
      await user.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    }
    expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Expiration date is required.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores a pending quote after expiration becomes invalid", async () => {
    const user = userEvent.setup();
    let resolveQuote!: (quote: { price: number }) => void;
    vi.mocked(resolveSymbolQuote).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        }),
    );
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" defaultUnitPrice={0} />);
    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("999");
    await act(async () => {
      resolveQuote({ price: 123 });
    });
    expect(screen.getByTestId("unit-price")).toHaveTextContent("0");
  });
  it("resolves the completed date only after focus leaves the picker", async () => {
    const user = userEvent.setup();
    vi.mocked(resolveSymbolQuote).mockClear();
    render(<OptionContractTestForm />);
    await user.click(screen.getByRole("spinbutton", { name: /month/i }));
    await user.keyboard("12");
    await user.click(screen.getByRole("spinbutton", { name: /day/i }));
    await user.keyboard("31");
    await user.click(screen.getByRole("spinbutton", { name: /year/i }));
    await user.keyboard("2027");
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-31");
    expect(resolveSymbolQuote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("spinbutton", { name: /month/i }));
    await user.keyboard("11");
    expect(resolveSymbolQuote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(resolveSymbolQuote).toHaveBeenCalledExactlyOnceWith(
        "AAPL271130C00150000",
        undefined,
        "OPTION",
      ),
    );
  });

  it("resolves a date loaded by the form without requiring a manual edit", async () => {
    const user = userEvent.setup();
    vi.mocked(resolveSymbolQuote).mockClear();
    render(<OptionContractTestForm />);
    await user.click(screen.getByRole("button", { name: "Reset expiration" }));
    await waitFor(() =>
      expect(resolveSymbolQuote).toHaveBeenCalledExactlyOnceWith(
        "AAPL300615C00150000",
        undefined,
        "OPTION",
      ),
    );
  });
  it("autofills and resolves a selected option contract", async () => {
    const user = userEvent.setup();
    vi.mocked(resolveSymbolQuote).mockClear();
    render(<OptionContractTestForm />);
    await user.click(screen.getByRole("button", { name: "Select option contract" }));
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("2028-01-21");
    expect(screen.getByRole("spinbutton", { name: /year/i })).toHaveAttribute(
      "aria-valuenow",
      "2028",
    );
    expect(screen.getByRole("textbox", { name: "Option underlying" })).toHaveValue("MSFT");
    await waitFor(() =>
      expect(resolveSymbolQuote).toHaveBeenCalledExactlyOnceWith(
        "MSFT280121P00200000",
        undefined,
        "OPTION",
      ),
    );
  });

  it("accepts a calendar selection and resolves it when editing ends", async () => {
    const user = userEvent.setup();
    render(<OptionContractTestForm defaultExpirationDate="2027-12-31" />);
    vi.mocked(resolveSymbolQuote).mockClear();
    await user.click(screen.getByRole("button", { name: /Pick a date/ }));
    await user.click(screen.getByRole("button", { name: /December 15, 2027/ }));
    expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-15");
    expect(resolveSymbolQuote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(resolveSymbolQuote).toHaveBeenCalledExactlyOnceWith(
        "AAPL271215C00150000",
        undefined,
        "OPTION",
      ),
    );
  });

  it("summarizes the strike in the option's quote currency, not the activity's", () => {
    render(
      <OptionContractTestForm
        defaultExpirationDate="2027-06-18"
        defaultStrikePrice={1234.5}
        defaultCurrency="CAD"
        defaultQuoteCcy="USD"
      />,
    );

    expect(screen.getByText("Jun 18 $1,234.50 CALL")).toBeInTheDocument();
  });

  it("summarizes the strike in the quote currency the provider confirms", async () => {
    vi.mocked(resolveSymbolQuote).mockResolvedValueOnce({ currency: "EUR" });
    render(
      <OptionContractTestForm
        defaultExpirationDate="2027-06-18"
        defaultStrikePrice={1234.5}
        defaultQuoteCcy="USD"
      />,
    );

    expect(await screen.findByText("Jun 18 €1,234.50 CALL")).toBeInTheDocument();
  });

  it("summarizes the strike in the activity currency without a quote currency", () => {
    render(
      <OptionContractTestForm
        defaultExpirationDate="2027-06-18"
        defaultStrikePrice={1234.5}
        defaultCurrency="CAD"
      />,
    );

    expect(screen.getByText("Jun 18 CA$1,234.50 CALL")).toBeInTheDocument();
  });
});
