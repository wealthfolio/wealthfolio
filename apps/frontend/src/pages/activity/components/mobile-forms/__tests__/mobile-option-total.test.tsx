import { ActivityType } from "@/lib/constants";
import { render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import type { NewActivityFormValues } from "../../forms/schemas";
import { MobileDetailsStep } from "../mobile-details-step";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

function OptionBuy({ currency, unitPrice }: { currency: string; unitPrice: number }) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType: ActivityType.BUY,
      accountId: "account",
      activityDate: new Date("2026-09-01T12:00:00Z"),
      assetType: "option",
      contractMultiplier: 100,
      quantity: 1,
      unitPrice,
      currency,
    } as Partial<NewActivityFormValues>,
  });
  const amountWasEdited = useRef(false);
  return (
    <FormProvider {...form}>
      <MobileDetailsStep
        accounts={[{ value: "account", label: "Brokerage", currency }]}
        activityType={ActivityType.BUY}
        amountWasEdited={amountWasEdited}
      />
    </FormProvider>
  );
}

describe("mobile option total", () => {
  it.each([
    ["JPY", 12.34, "¥1,234"],
    ["KWD", 0.01234, "KWD 1.234"],
    ["USD", 12.345, "$1,234.50"],
  ])("shows a %s total in its minor units", (currency, unitPrice, total) => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OptionBuy currency={currency} unitPrice={unitPrice} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Total Debit")).toBeInTheDocument();
    expect(screen.getByText(total)).toBeInTheDocument();
  });
});
