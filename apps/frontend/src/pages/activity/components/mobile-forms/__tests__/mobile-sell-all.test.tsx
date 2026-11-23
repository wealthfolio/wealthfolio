import { ACTIVITY_SUBTYPES, ActivityStatus, ActivityType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewActivityFormValues } from "../../forms/schemas";
import type { IncomeAmountTypedLast } from "../../forms/use-income-amounts";
import { MobileDetailsStep } from "../mobile-details-step";
import { MobileActivityForm } from "../mobile-activity-form";

const mocks = vi.hoisted(() => ({ quantity: 1.12345678, isFetching: false }));

beforeEach(() => {
  mocks.quantity = 1.12345678;
  mocks.isFetching = false;
});

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({
    holdings: [
      { instrument: { id: "aapl-id", symbol: "AAPL" }, quantity: mocks.quantity } as Holding,
    ],
    isLoading: false,
    isFetching: mocks.isFetching,
    isError: false,
  }),
}));

vi.mock("@/pages/activity/hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    addActivityMutation: { mutateAsync: vi.fn(), isPending: false },
    updateActivityMutation: { mutateAsync: vi.fn(), isPending: false },
    saveActivitiesMutation: { mutateAsync: vi.fn(), isPending: false },
    saveInternalTransferPairMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("@wealthfolio/ui/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <>{children}</> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  resolveSymbolQuote: vi.fn().mockResolvedValue(null),
}));

function TestForm({
  onSubmit,
  subtype = null,
}: {
  onSubmit: (data: NewActivityFormValues) => void;
  subtype?: string | null;
}) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType: ActivityType.SELL,
      accountId: "brokerage",
      assetId: "AAPL",
      existingAssetId: "aapl-id",
      activityDate: new Date("2026-05-12T15:00:00Z"),
      currency: "USD",
      unitPrice: 10,
      fee: 0,
      tax: 0,
      subtype,
    },
  });
  const amountWasEdited = useRef(false);
  const incomeAmountTypedLast = useRef<IncomeAmountTypedLast>("gross");
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <MobileDetailsStep
          accounts={[{ value: "brokerage", label: "Brokerage", currency: "USD" }]}
          activityType={ActivityType.SELL}
          amountWasEdited={amountWasEdited}
          incomeAmountTypedLast={incomeAmountTypedLast}
        />
        <button type="submit">Save test sale</button>
      </form>
    </FormProvider>
  );
}

describe("mobile Sell all", () => {
  it("waits for refreshed holdings before filling the quantity", async () => {
    mocks.isFetching = true;
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const client = new QueryClient();
    const { rerender } = render(<TestForm onSubmit={onSubmit} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    expect(screen.getByRole("button", { name: "Sell all" })).toBeDisabled();

    mocks.quantity = 0.00000001;
    mocks.isFetching = false;
    rerender(<TestForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Sell all" }));
    expect(screen.getByRole("textbox", { name: "Shares" })).toHaveValue("0.00000001");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { activityType: ActivityType.UNKNOWN, status: ActivityStatus.POSTED, expected: "10" },
    { activityType: ActivityType.SELL, status: ActivityStatus.DRAFT, expected: "10" },
    { activityType: ActivityType.SELL, status: ActivityStatus.PENDING, expected: "10" },
    { activityType: ActivityType.SELL, status: ActivityStatus.VOID, expected: "10" },
    { activityType: ActivityType.SELL, status: ActivityStatus.POSTED, expected: "12" },
  ])(
    "restores units only from an original posted sell: $status $activityType",
    async ({ activityType, status, expected }) => {
      mocks.quantity = 10;
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MobileActivityForm
            accounts={[{ value: "brokerage", label: "Brokerage", currency: "USD" }]}
            activity={{
              id: "row-1",
              activityType,
              status,
              accountId: "brokerage",
              assetId: "aapl-id",
              assetSymbol: "AAPL",
              currency: "USD",
              quantity: "2",
              unitPrice: "10",
            }}
            open
            onClose={vi.fn()}
          />
        </QueryClientProvider>,
      );
      if (activityType === ActivityType.UNKNOWN) {
        await user.click(screen.getByRole("radio", { name: /^Sell/ }));
        await user.click(screen.getByRole("button", { name: "Next" }));
      }
      await user.click(screen.getByRole("button", { name: "Sell all" }));
      expect(screen.getByRole("textbox", { name: "Shares" })).toHaveValue(expected);
    },
  );

  it("fills and submits the eight-decimal holding quantity using the canonical asset id", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TestForm onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Sell all" }));
    expect(screen.getByRole("textbox", { name: "Shares" })).toHaveValue("1.12345678");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save test sale" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 1.12345678, existingAssetId: "aapl-id" }),
        expect.anything(),
      ),
    );
  });

  it("does not offer Sell all when opening a short position", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TestForm onSubmit={vi.fn()} subtype={ACTIVITY_SUBTYPES.POSITION_OPEN} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Sell all" })).not.toBeInTheDocument();
  });
});
