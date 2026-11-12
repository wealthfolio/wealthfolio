import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import { render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import type { NewActivityFormValues } from "../../forms/schemas";
import type { IncomeAmountTypedLast } from "../../forms/use-income-amounts";
import { MobileDetailsStep } from "../mobile-details-step";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

const accounts: AccountSelectOption[] = [
  { value: "usd-account", label: "USD account", currency: "USD", accountType: "SECURITIES" },
  // The activity page blocks cards, as getActivityRestrictionLevel does.
  {
    value: "card-account",
    label: "Card",
    currency: "USD",
    accountType: "CREDIT_CARD",
    restrictionLevel: "blocked",
  },
];

function TestForm({
  activityType,
  subtype,
  accountId = "usd-account",
}: {
  activityType: string;
  subtype: string | null;
  accountId?: string;
}) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType,
      accountId,
      activityDate: new Date("2026-09-01T12:00:00Z"),
      currency: "USD",
      subtype,
    } as NewActivityFormValues,
  });
  const amountWasEdited = useRef(false);
  const incomeAmountTypedLast = useRef<IncomeAmountTypedLast>("gross");
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <FormProvider {...form}>
        <MobileDetailsStep
          accounts={accounts}
          activityType={activityType}
          amountWasEdited={amountWasEdited}
          incomeAmountTypedLast={incomeAmountTypedLast}
        />
      </FormProvider>
    </QueryClientProvider>
  );
}

describe("mobile income amount label", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([ActivityType.DIVIDEND, ActivityType.INTEREST])(
    "asks a cash %s for the amount received after fees and taxes",
    (activityType) => {
      render(<TestForm activityType={activityType} subtype={null} />);

      expect(screen.getByText("Received amount")).toBeInTheDocument();
      expect(screen.getByText("Final cash received, after fees and taxes.")).toBeInTheDocument();
    },
  );

  it.each([
    [ActivityType.DIVIDEND, ACTIVITY_SUBTYPES.DRIP, "Dividend Amount"],
    [ActivityType.INTEREST, ACTIVITY_SUBTYPES.STAKING_REWARD, "Interest Amount"],
  ])("keeps the value label for a %s paid as %s", (activityType, subtype, label) => {
    render(<TestForm activityType={activityType} subtype={subtype} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Final cash received, after fees and taxes.")).toBeNull();
  });

  it("does not call credit-card interest, a charge, an amount received", () => {
    render(
      <TestForm activityType={ActivityType.INTEREST} subtype={null} accountId="card-account" />,
    );

    expect(screen.getByText("Interest Amount")).toBeInTheDocument();
    expect(screen.queryByText("Received amount")).toBeNull();
    expect(screen.queryByText("Final cash received, after fees and taxes.")).toBeNull();
  });
});
