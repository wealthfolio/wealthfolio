import { ActivityEditCancelled } from "@/features/spending/components/activity-split-review-provider";
import { toast } from "sonner";
import { ActivityType, InstrumentType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { render as renderWithFormatting, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { Activity, type ReactElement, type ReactNode, type RefObject } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import { MobileActivityForm } from "../mobile-activity-form";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithFormatting(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

// The type step scrolls its options, and the scroll area needs a
// ResizeObserver jsdom does not provide.
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

vi.mock("@wealthfolio/ui/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          Close sheet
        </button>
        {children}
      </>
    ) : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

// The details step has its own field-level coverage; what matters here is which
// type it is handed, and whether it is reached at all.
vi.mock("../mobile-details-step", async () => {
  const { useFormContext } = await import("react-hook-form");
  return {
    MobileDetailsStep: ({
      activityType,
      isEditing,
      amountWasEdited,
    }: {
      activityType?: string;
      isEditing?: boolean;
      amountWasEdited?: RefObject<boolean>;
    }) => {
      const form = useFormContext();
      return (
        <div
          data-testid="details-step"
          data-editing={String(!!isEditing)}
          data-quote-ccy={form.getValues("symbolQuoteCcy")}
          data-fee={String(form.getValues("fee"))}
          data-tax={String(form.getValues("tax"))}
        >
          {activityType ?? "no-type"}
          <input aria-label="Record notes" {...form.register("comment")} />
          <button
            type="button"
            onClick={() => form.setValue("activityDate", new Date("2026-02-01T10:00:00Z"))}
          >
            Correct record date
          </button>
          <button
            type="button"
            onClick={() => form.setValue("fee", undefined, { shouldDirty: true })}
          >
            Clear fee
          </button>
          <button
            type="button"
            onClick={() => {
              form.setValue("feeLines", [], { shouldDirty: true });
              form.setValue("taxLines", [], { shouldDirty: true });
            }}
          >
            Remove fee and tax lines
          </button>
          {[false, true].map((unfinished) => (
            <button
              key={String(unfinished)}
              type="button"
              onClick={() => {
                form.setValue("fee", 5, { shouldDirty: true });
                form.setValue("feeLines", [{ label: unfinished ? "" : "Commission", amount: 5 }], {
                  shouldDirty: true,
                });
                form.setValue("tax", 2, { shouldDirty: true });
                form.setValue("taxLines", [{ label: "Stamp duty", amount: 2 }], {
                  shouldDirty: true,
                });
              }}
            >
              {unfinished ? "Enter an unfinished fee line" : "Enter fee and tax lines"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              form.setValue("accountId", "acc_1");
              form.setValue("currency", "USD");
              form.setValue("fee", 0);
              form.setValue("tax", 0);
              form.setValue("assetId", "AAPL");
              form.setValue("quantity", 2);
              form.setValue("unitPrice", 25);
              form.setValue("amount", 60);
              if (amountWasEdited) amountWasEdited.current = true;
            }}
          >
            Enter a trade with its own total
          </button>
          {[
            { label: "Enter a dividend before tax", grossAmount: 100, tax: 15, fee: 0, amount: 85 },
            {
              label: "Enter a tax above the dividend",
              grossAmount: 10,
              tax: 15,
              fee: 0,
              amount: 0,
            },
            {
              label: "Enter charges above the interest",
              grossAmount: 10,
              tax: 5,
              fee: 10,
              amount: 0,
            },
          ].map(({ label, grossAmount, tax, fee, amount }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                form.setValue("accountId", "acc_1");
                form.setValue("currency", "USD");
                if (activityType === ActivityType.DIVIDEND) form.setValue("assetId", "AAPL");
                form.setValue("grossAmount", grossAmount);
                form.setValue("tax", tax);
                form.setValue("fee", fee);
                form.setValue("amount", amount);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      );
    },
  };
});

// The sheet form records and edits a conversion; a stub shows what it got.
vi.mock("../../activity-form", () => ({
  ActivityForm: ({
    activity,
    hidePicker,
  }: {
    activity?: Partial<ActivityDetails>;
    hidePicker?: boolean;
  }) => (
    <div
      data-testid="sheet-form"
      data-subtype={activity?.subtype}
      data-account={activity?.accountId}
      data-hide-picker={String(!!hidePicker)}
    />
  ),
}));

const noopMutation = { mutateAsync: vi.fn(), isPending: false };
const savePairMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    addActivityMutation: noopMutation,
    updateActivityMutation: noopMutation,
    deleteActivityMutation: noopMutation,
    duplicateActivityMutation: noopMutation,
    saveActivitiesMutation: noopMutation,
    saveInternalTransferPairMutation: savePairMutation,
    linkTransferActivitiesMutation: noopMutation,
    unlinkTransferActivitiesMutation: noopMutation,
  }),
}));

const accounts: AccountSelectOption[] = [
  { value: "acc_1", label: "Brokerage", currency: "USD" } as AccountSelectOption,
];

function activity(activityType: ActivityType): Partial<ActivityDetails> {
  return {
    id: "act_1",
    activityType,
    accountId: "acc_1",
    currency: "USD",
    date: new Date("2026-01-15T00:00:00Z"),
  };
}

function renderForm(activityToEdit: Partial<ActivityDetails>) {
  return render(
    <MobileActivityForm accounts={accounts} open onClose={vi.fn()} activity={activityToEdit} />,
  );
}

describe("MobileActivityForm reclassification", () => {
  it("keeps provider-only types out of the ordinary creation picker", () => {
    render(<MobileActivityForm accounts={accounts} open onClose={vi.fn()} />);

    expect(screen.queryByRole("radio", { name: /Credit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^Adjustment\b/i })).not.toBeInTheDocument();
  });

  it("starts an activity with no editable type on the type step", () => {
    renderForm(activity(ActivityType.UNKNOWN));

    expect(screen.getByText("Select Transaction Type")).toBeInTheDocument();
    expect(screen.queryByTestId("details-step")).not.toBeInTheDocument();
  });

  it("reaches the details step for the type picked to replace UNKNOWN", async () => {
    const user = userEvent.setup();
    renderForm(activity(ActivityType.UNKNOWN));

    await user.click(screen.getByRole("radio", { name: /Deposit/i }));
    await user.click(screen.getByRole("button", { name: /Next/i }));

    const details = await screen.findByTestId("details-step");
    expect(details).toHaveTextContent(ActivityType.DEPOSIT);
    // Still an edit of the existing row, not a new activity.
    expect(details).toHaveAttribute("data-editing", "true");
  });

  it("can reclassify UNKNOWN as CREDIT", async () => {
    const user = userEvent.setup();
    renderForm(activity(ActivityType.UNKNOWN));

    await user.click(screen.getByRole("radio", { name: /Credit/i }));
    await user.click(screen.getByRole("button", { name: /Next/i }));

    expect(await screen.findByTestId("details-step")).toHaveTextContent(ActivityType.CREDIT);
  });

  it.each([ActivityType.CREDIT, ActivityType.ADJUSTMENT])(
    "edits a %s row on its own type without a type step",
    (activityType) => {
      renderForm(activity(activityType));

      expect(screen.queryByText("Select Transaction Type")).not.toBeInTheDocument();
      expect(screen.getByTestId("details-step")).toHaveTextContent(activityType);
    },
  );
});

describe("MobileActivityForm conversions", () => {
  it("hands a new conversion to the sheet form, which records both rows", async () => {
    const user = userEvent.setup();
    render(
      <MobileActivityForm
        accounts={accounts}
        open
        onClose={vi.fn()}
        activity={{ accountId: "acc_1" }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Conversion/i }));

    const sheet = await screen.findByTestId("sheet-form");
    expect(sheet).toHaveAttribute("data-subtype", "CONVERSION_OUT");
    expect(sheet).toHaveAttribute("data-account", "acc_1");
    expect(sheet).toHaveAttribute("data-hide-picker", "true");
  });

  it("edits a conversion row in the sheet form", () => {
    renderForm({
      ...activity(ActivityType.ADJUSTMENT),
      subtype: "CONVERSION_IN",
      sourceGroupId: "conv-1",
    });

    expect(screen.getByTestId("sheet-form")).toHaveAttribute("data-subtype", "CONVERSION_IN");
  });

  it("keeps a conversion, which is two rows, out of reclassifying one row", () => {
    renderForm(activity(ActivityType.UNKNOWN));

    expect(screen.getByText("Select Transaction Type")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Conversion/i })).not.toBeInTheDocument();
  });
});

describe("mobile linked transfer edits", () => {
  it.each([ActivityType.TRANSFER_OUT, ActivityType.TRANSFER_IN])(
    "sends the selected %s record with date and notes corrections in one pair save",
    async (activityType) => {
      savePairMutation.mutateAsync.mockReset().mockResolvedValue({});
      const incoming = activityType === ActivityType.TRANSFER_IN;
      const selectedId = incoming ? "pair-in" : "pair-out";
      const user = userEvent.setup();
      render(
        <MobileActivityForm
          accounts={[...accounts, { value: "acc_2", label: "Other account", currency: "CAD" }]}
          open
          onClose={vi.fn()}
          activity={{
            id: selectedId,
            activityType,
            accountId: incoming ? "acc_2" : "acc_1",
            counterpartAccountId: incoming ? "acc_1" : "acc_2",
            currency: incoming ? "CAD" : "USD",
            counterpartCurrency: incoming ? "USD" : "CAD",
            amount: incoming ? "130" : "100",
            counterpartAmount: incoming ? "100" : "130",
            transferOutId: "pair-out",
            transferInId: "pair-in",
            sourceRecordId: "provider-record",
            sourceGroupId: "wf-transfer-pair",
            date: new Date("2026-01-18T00:00:00Z"),
            comment: "Original reference",
          }}
        />,
      );
      await user.clear(screen.getByRole("textbox", { name: "Record notes" }));
      await user.click(screen.getByRole("button", { name: "Correct record date" }));
      await user.click(screen.getByRole("button", { name: "Update Activity" }));
      await waitFor(() =>
        expect(savePairMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            editedActivityId: selectedId,
            transferOutId: "pair-out",
            transferInId: "pair-in",
            fromAccountId: "acc_1",
            toAccountId: "acc_2",
            sourceAmount: 100,
            destinationAmount: 130,
            activityDate: new Date("2026-02-01T10:00:00Z"),
            notes: "",
          }),
        ),
      );
    },
  );
});

describe("MobileActivityForm option defaults", () => {
  const option = {
    ...activity(ActivityType.BUY),
    instrumentType: "OPTION",
    assetSymbol: "AAPL270618C01234500",
    currency: "CAD",
  };

  it("starts the quote currency from the option's, not the activity's", () => {
    renderForm({ ...option, assetQuoteCcy: "USD" });

    expect(screen.getByTestId("details-step")).toHaveAttribute("data-quote-ccy", "USD");
  });

  it("starts the quote currency from the activity's when the option's is unknown", () => {
    renderForm(option);

    expect(screen.getByTestId("details-step")).toHaveAttribute("data-quote-ccy", "CAD");
  });
});

describe("mobile trade asset identity", () => {
  it.each([ActivityType.BUY, ActivityType.SELL])(
    "submits the stored %s instrument type and quote currency without reselection",
    async (type) => {
      noopMutation.mutateAsync.mockReset().mockResolvedValue({});
      const user = userEvent.setup();
      renderForm({
        ...activity(type),
        assetId: "asset-usdt",
        assetSymbol: "USDT",
        instrumentType: InstrumentType.CRYPTO,
        assetQuoteCcy: "USD",
        currency: "CAD",
        quantity: "2",
        unitPrice: "25",
        amount: "50",
      });

      await user.click(screen.getByRole("button", { name: "Update Activity" }));

      await waitFor(() =>
        expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            id: "act_1",
            assetId: "USDT",
            currentAssetId: "asset-usdt",
            symbolInstrumentType: InstrumentType.CRYPTO,
            symbolQuoteCcy: "USD",
            currency: "CAD",
          }),
        ),
      );
    },
  );
});

describe("a trade total typed on a phone screen left for another tab", () => {
  it("is still submitted when the user comes back and saves", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    // On a phone, a screen left for another tab is a hidden <Activity>.
    const form = (hidden: boolean) => (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <MobileActivityForm accounts={accounts} open onClose={vi.fn()} />
      </Activity>
    );
    const { rerender } = render(form(false));
    await user.click(screen.getByRole("radio", { name: /^Buy\b/i }));
    await user.click(screen.getByRole("button", { name: /Next/i }));
    await user.click(
      await screen.findByRole("button", { name: "Enter a trade with its own total" }),
    );

    rerender(form(true));
    rerender(form(false));
    await user.click(screen.getByRole("button", { name: "Add Activity" }));

    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ activityType: ActivityType.BUY, amount: 60 }),
      ),
    );
  });
});

describe("fee and tax lines on a phone edit", () => {
  const buyWithLines = {
    ...activity(ActivityType.BUY),
    assetId: "AAPL",
    assetSymbol: "AAPL",
    quantity: "2",
    unitPrice: "25",
    amount: "61.49",
    fee: "9.99",
    tax: "1.5",
    metadata: {
      charges: [
        { category: "fee", label: "Commission", amount: "8.00" },
        { category: "fee", label: "Exchange fee", amount: "1.99" },
        { category: "tax", label: "Stamp duty", amount: "1.50" },
      ],
    },
  };

  it("saves the lines it opened with", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm(buyWithLines);

    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: "act_1",
          metadata: {
            charges: [
              { category: "fee", label: "Commission", amount: "8" },
              { category: "fee", label: "Exchange fee", amount: "1.99" },
              { category: "tax", label: "Stamp duty", amount: "1.5" },
            ],
          },
        }),
      ),
    );
    const sent = noopMutation.mutateAsync.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ["feeLines", "taxLines", "hadChargeLines", "chargeLinesLocked"]) {
      expect(sent).not.toHaveProperty(field);
    }
  });

  it("clears the lines once all are removed", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm(buyWithLines);

    await user.click(screen.getByRole("button", { name: "Remove fee and tax lines" }));
    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "act_1", metadata: { charges: null } }),
      ),
    );
  });

  it("sends no lines for a type without a lines editor", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({ ...activity(ActivityType.DEPOSIT), amount: "100", fee: "5" });

    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(noopMutation.mutateAsync.mock.calls[0][0]).not.toHaveProperty("metadata");
  });

  it("preserves a stored dividend's locked fee when opening it", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({
      ...buyWithLines,
      activityType: ActivityType.DIVIDEND,
      amount: "100",
    });

    await user.click(screen.getByRole("button", { name: "Update Activity" }));

    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(noopMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      activityType: ActivityType.DIVIDEND,
      fee: 9.99,
      tax: 1.5,
    });
    expect(noopMutation.mutateAsync.mock.calls[0][0]).not.toHaveProperty("metadata");
  });
});

describe("phone charge lines after changing type", () => {
  it("closes without discarding when only dividend was selected", async () => {
    const close = vi.fn();
    render(<MobileActivityForm accounts={accounts} open onClose={close} />);
    await userEvent.click(screen.getByRole("radio", { name: /Dividend/i }));
    await userEvent.click(screen.getByRole("button", { name: "Close sheet" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  const startBuy = async () => {
    renderForm({
      accountId: "acc_1",
      currency: "USD",
      amount: "100",
      assetId: "AAPL",
      assetSymbol: "AAPL",
      quantity: "2",
      unitPrice: "25",
    });
    await userEvent.click(screen.getByRole("radio", { name: /Buy/i }));
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));
  };

  it("discards an unfinished fee line and its hidden fee when switching to dividend", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    await startBuy();
    await userEvent.click(screen.getByRole("button", { name: "Enter an unfinished fee line" }));
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    await userEvent.click(screen.getByRole("radio", { name: /Dividend/i }));
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));
    await userEvent.click(screen.getByRole("button", { name: "Add Activity" }));

    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(noopMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      activityType: ActivityType.DIVIDEND,
      fee: 0,
      tax: 2,
      metadata: { charges: [{ category: "tax", label: "Stamp duty", amount: "2" }] },
    });
  });

  it("drops trade lines when switching to deposit without submitting metadata", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    await startBuy();
    await userEvent.click(screen.getByRole("button", { name: "Enter fee and tax lines" }));
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    await userEvent.click(screen.getByRole("radio", { name: /Deposit/i }));
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));
    await userEvent.click(screen.getByRole("button", { name: "Add Activity" }));

    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(noopMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      activityType: ActivityType.DEPOSIT,
      fee: 5,
    });
    expect(noopMutation.mutateAsync.mock.calls[0][0]).not.toHaveProperty("metadata");
  });

  it("keeps compatible fee and tax lines when switching from buy to sell", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    await startBuy();
    await userEvent.click(screen.getByRole("button", { name: "Enter fee and tax lines" }));
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    await userEvent.click(screen.getByRole("radio", { name: /Sell/i }));
    await userEvent.click(screen.getByRole("button", { name: /Next/i }));
    await userEvent.click(screen.getByRole("button", { name: "Add Activity" }));

    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    expect(noopMutation.mutateAsync.mock.calls[0][0]).toMatchObject({
      activityType: ActivityType.SELL,
      fee: 5,
      tax: 2,
      metadata: {
        charges: [
          { category: "fee", label: "Commission", amount: "5" },
          { category: "tax", label: "Stamp duty", amount: "2" },
        ],
      },
    });
  });
});

describe("saved charges on a phone edit", () => {
  it("opens a saved 0 fee and tax empty and still saves them as 0", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({ ...activity(ActivityType.DEPOSIT), amount: "100", fee: "0", tax: "0" });

    const details = screen.getByTestId("details-step");
    expect(details).toHaveAttribute("data-fee", "undefined");
    expect(details).toHaveAttribute("data-tax", "undefined");

    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "act_1", amount: 100, fee: 0 }),
      ),
    );
  });

  it("saves a cleared fee as 0", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({ ...activity(ActivityType.DEPOSIT), amount: "100", fee: "5" });

    await user.click(screen.getByRole("button", { name: "Clear fee" }));
    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "act_1", amount: 100, fee: 0 }),
      ),
    );
  });

  it("saves an external transfer's cleared fee as 0", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({
      ...activity(ActivityType.TRANSFER_OUT),
      amount: "100",
      fee: "5",
      metadata: { flow: { is_external: true } },
    });

    await user.click(screen.getByRole("button", { name: "Clear fee" }));
    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() =>
      expect(noopMutation.mutateAsync).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "act_1", activityType: ActivityType.TRANSFER_OUT, fee: 0 }),
      ),
    );
  });

  it("leaves both legs' fees as stored when a securities transfer's fee is cleared", async () => {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <MobileActivityForm
        accounts={[...accounts, { value: "acc_2", label: "Other account", currency: "USD" }]}
        open
        onClose={vi.fn()}
        activity={{
          id: "pair-out",
          activityType: ActivityType.TRANSFER_OUT,
          accountId: "acc_1",
          counterpartAccountId: "acc_2",
          currency: "USD",
          assetId: "asset-aapl",
          assetSymbol: "AAPL",
          quantity: "2",
          unitPrice: "100",
          fee: "5",
          transferOutId: "pair-out",
          transferInId: "pair-in",
          date: new Date("2026-01-18T00:00:00Z"),
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear fee" }));
    await user.click(screen.getByRole("button", { name: "Update Activity" }));
    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    const { updates } = noopMutation.mutateAsync.mock.calls[0][0];
    expect(updates.map((leg: { id: string }) => leg.id)).toEqual(["pair-out", "pair-in"]);
    for (const leg of updates) expect(leg.fee).toBeUndefined();
  });

  it("opens a saved charge with its value", () => {
    renderForm({ ...activity(ActivityType.DEPOSIT), amount: "100", fee: "1.5", tax: "2" });

    const details = screen.getByTestId("details-step");
    expect(details).toHaveAttribute("data-fee", "1.5");
    expect(details).toHaveAttribute("data-tax", "2");
  });
});

describe("income entered before tax on a phone", () => {
  async function enterIncome(type: RegExp, button: string) {
    noopMutation.mutateAsync.mockReset().mockResolvedValue({});
    const user = userEvent.setup();
    render(<MobileActivityForm accounts={accounts} open onClose={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: type }));
    await user.click(screen.getByRole("button", { name: /Next/i }));
    await user.click(await screen.findByRole("button", { name: button }));
    await user.click(screen.getByRole("button", { name: "Add Activity" }));
  }

  it("saves the received amount and not the amount before tax", async () => {
    await enterIncome(/^Dividend\b/i, "Enter a dividend before tax");

    await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledOnce());
    const saved = noopMutation.mutateAsync.mock.calls[0][0];
    expect(saved).toMatchObject({ activityType: ActivityType.DIVIDEND, amount: 85, tax: 15 });
    expect(saved).not.toHaveProperty("grossAmount");
  });

  it("is refused when the tax is more than the amount before tax", async () => {
    await enterIncome(/^Dividend\b/i, "Enter a tax above the dividend");

    // The details step stays open instead of saving.
    expect(await screen.findByTestId("details-step")).toBeInTheDocument();
    expect(noopMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("is refused when interest's tax and fee together are more than it", async () => {
    await enterIncome(/^Interest\b/i, "Enter charges above the interest");

    expect(await screen.findByTestId("details-step")).toBeInTheDocument();
    expect(noopMutation.mutateAsync).not.toHaveBeenCalled();
  });
});

it("keeps a mobile edit open without a failure toast when split review is cancelled", async () => {
  const previousCalls = noopMutation.mutateAsync.mock.calls.length;
  noopMutation.mutateAsync.mockRejectedValueOnce(new ActivityEditCancelled());
  const errorToast = vi.spyOn(toast, "error");
  const close = vi.fn();
  const user = userEvent.setup();
  render(
    <MobileActivityForm
      accounts={accounts}
      open
      onClose={close}
      activity={{ ...activity(ActivityType.DEPOSIT), amount: "100" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Update Activity" }));
  await waitFor(() => expect(noopMutation.mutateAsync).toHaveBeenCalledTimes(previousCalls + 1));
  expect(errorToast).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByTestId("details-step")).toBeInTheDocument();
  errorToast.mockRestore();
});
