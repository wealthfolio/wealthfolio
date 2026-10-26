import { ActivityEditCancelled } from "@/features/spending/components/activity-split-review-provider";
import { toast } from "sonner";
import { ActivityType, InstrumentType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Activity, type ReactNode, type RefObject } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import { MobileActivityForm } from "../mobile-activity-form";

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
  Sheet: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <>{children}</> : null,
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
        </div>
      );
    },
  };
});

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
