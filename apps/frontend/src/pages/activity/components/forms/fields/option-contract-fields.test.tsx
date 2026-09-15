import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { render, screen, waitFor } from "@/test/render";
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
  default: ({ value }: { value?: string }) => (
    <input aria-label="Option underlying" value={value ?? ""} readOnly />
  ),
}));

function OptionContractTestForm({
  defaultExpirationDate,
  onSubmit = () => undefined,
}: {
  defaultExpirationDate?: string;
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
      unitPrice: 5,
      fee: 0,
      tax: 0,
      currency: "USD",
      underlyingSymbol: "AAPL",
      strikePrice: 150,
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

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <OptionContractFields
          underlyingName="underlyingSymbol"
          strikePriceName="strikePrice"
          expirationDateName="expirationDate"
          optionTypeName="optionType"
        />
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
    render(<OptionContractTestForm />);

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
    expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();

    await user.keyboard("027");
    expect(year).toHaveAttribute("aria-valuenow", "2027");
    await user.tab();

    await waitFor(() => {
      expect(screen.getByTestId("expiration-value")).toHaveTextContent("2027-12-31");
    });
  });

  it("does not commit an expiration year below 1000", async () => {
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
    expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
  });

  it("discards an incomplete draft when the form loads a different date", async () => {
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
      expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();
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
    expect(screen.getByTestId("expiration-value")).toBeEmptyDOMElement();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Expiration date is required.")).toBeInTheDocument();
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
});
