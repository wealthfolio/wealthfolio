import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useFormContext } from "react-hook-form";
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
vi.mock("../mobile-details-step", () => ({
  MobileDetailsStep: ({
    activityType,
    isEditing,
  }: {
    activityType?: string;
    isEditing?: boolean;
  }) => (
    <div
      data-testid="details-step"
      data-editing={String(!!isEditing)}
      data-quote-ccy={useFormContext<{ symbolQuoteCcy?: string }>().getValues("symbolQuoteCcy")}
    >
      {activityType ?? "no-type"}
    </div>
  ),
}));

const noopMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    addActivityMutation: noopMutation,
    updateActivityMutation: noopMutation,
    deleteActivityMutation: noopMutation,
    duplicateActivityMutation: noopMutation,
    saveActivitiesMutation: noopMutation,
    saveInternalTransferPairMutation: noopMutation,
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
