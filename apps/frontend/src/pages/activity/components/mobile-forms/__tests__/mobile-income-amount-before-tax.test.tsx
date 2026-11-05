import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import { render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import type { NewActivityFormValues } from "../../forms/schemas";
import { MobileDetailsStep } from "../mobile-details-step";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

const accounts: AccountSelectOption[] = [
  { value: "usd-account", label: "USD account", currency: "USD", accountType: "SECURITIES" },
];

function TestForm({
  activityType,
  subtype = null,
  saved,
}: {
  activityType: string;
  subtype?: string | null;
  saved?: { amount: number; tax: number; fee?: number };
}) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType,
      accountId: "usd-account",
      activityDate: new Date("2026-09-01T12:00:00Z"),
      currency: "USD",
      subtype,
      fee: 0,
      tax: 0,
      ...saved,
    } as NewActivityFormValues,
  });
  const amountWasEdited = useRef(false);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <FormProvider {...form}>
        <MobileDetailsStep
          accounts={accounts}
          activityType={activityType}
          isEditing={saved !== undefined}
          amountWasEdited={amountWasEdited}
        />
      </FormProvider>
    </QueryClientProvider>
  );
}

const field = (label: string) => screen.getByLabelText(label);

async function retype(label: string, value: string) {
  const input = field(label);
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe("mobile income amount before tax", () => {
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

  it("works out a dividend's received amount", async () => {
    render(<TestForm activityType={ActivityType.DIVIDEND} />);

    await retype("Amount before tax", "2.63");
    await retype("Withholding tax (Optional)", "0.33");

    expect(field("Received amount")).toHaveValue("2.3");
  });

  it("keeps a typed received amount and works out the amount before tax", async () => {
    render(<TestForm activityType={ActivityType.DIVIDEND} />);

    await retype("Received amount", "85");
    await retype("Withholding tax (Optional)", "15");

    expect(field("Received amount")).toHaveValue("85");
    expect(field("Amount before tax")).toHaveValue("100");
  });

  it("takes interest's fee off as well as its tax", async () => {
    render(<TestForm activityType={ActivityType.INTEREST} />);

    await retype("Amount before tax", "100");
    await retype("Withholding tax (Optional)", "15");
    await retype("Fee (Optional)", "1");

    expect(field("Received amount")).toHaveValue("84");
  });

  it("rebuilds the amount before tax when a saved dividend is edited", async () => {
    render(<TestForm activityType={ActivityType.DIVIDEND} saved={{ amount: 85, tax: 15 }} />);

    await waitFor(() => expect(field("Amount before tax")).toHaveValue("100"));
  });

  it("leaves a reinvested dividend's amount as it is", () => {
    render(<TestForm activityType={ActivityType.DIVIDEND} subtype={ACTIVITY_SUBTYPES.DRIP} />);

    expect(screen.queryByLabelText("Amount before tax")).toBeNull();
  });
});
