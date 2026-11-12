import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import type { Account } from "@/lib/types";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import type { NewActivityFormValues } from "../../forms/schemas";
import type { IncomeAmountTypedLast } from "../../forms/use-income-amounts";
import { MobileDetailsStep } from "../mobile-details-step";

vi.mock("@wealthfolio/ui/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

function accountOption(
  id: string,
  accountType: Account["accountType"],
  trackingMode: Account["trackingMode"] = "TRANSACTIONS",
  providerAccountId?: string,
): AccountSelectOption {
  const account: Account = {
    id,
    name: id,
    accountType,
    trackingMode,
    providerAccountId,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    createdAt: new Date("2026-11-08T12:00:00Z"),
    updatedAt: new Date("2026-11-08T12:00:00Z"),
  };
  return {
    value: id,
    label: id,
    currency: account.currency,
    accountType,
    restrictionLevel: getActivityRestrictionLevel(account),
  };
}

const accounts = [
  accountOption("Checking", "CASH"),
  accountOption("Brokerage", "SECURITIES"),
  accountOption("Card", "CREDIT_CARD"),
  // Securities must exclude a card even if a caller omits its restriction flag.
  { value: "other-card", label: "Other Card", currency: "USD", accountType: "CREDIT_CARD" },
  accountOption("Manual holdings", "SECURITIES", "HOLDINGS"),
  accountOption("Connected holdings", "SECURITIES", "HOLDINGS", "provider-account"),
];

function TestForm({
  activityType = "TRANSFER_OUT",
  transferMode = "cash",
  isExternal = false,
  direction = "out",
  isEditing = false,
}: {
  activityType?: string;
  transferMode?: "cash" | "securities";
  isExternal?: boolean;
  direction?: "in" | "out";
  isEditing?: boolean;
}) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType,
      accountId: "Checking",
      transferMode,
      isExternal,
      direction,
      currency: "USD",
      activityDate: new Date("2026-11-08T12:00:00Z"),
    } as NewActivityFormValues,
  });
  const amountWasEdited = useRef(false);
  const incomeAmountTypedLast = useRef<IncomeAmountTypedLast>("gross");
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <Sheet open>
        <SheetContent>
          <SheetTitle>Transfer</SheetTitle>
          <FormProvider {...form}>
            <MobileDetailsStep
              accounts={accounts}
              activityType={activityType}
              isEditing={isEditing}
              amountWasEdited={amountWasEdited}
              incomeAmountTypedLast={incomeAmountTypedLast}
            />
          </FormProvider>
        </SheetContent>
      </Sheet>
    </QueryClientProvider>
  );
}

describe("mobile transfer account pickers", () => {
  it.each([
    ["From Account", false],
    ["To Account", false],
    ["From Account", true],
    ["To Account", true],
  ])("allows a card in cash %s (editing: %s)", async (label, isEditing) => {
    const user = userEvent.setup();
    render(<TestForm isEditing={isEditing} />);
    await user.click(screen.getByRole("combobox", { name: label }));
    expect(await screen.findByRole("option", { name: /Checking/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Manual holdings|Connected holdings/ })).toBeNull();
    await user.click(screen.getByRole("option", { name: /^Card/ }));
    expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("Card (USD)");
  });

  it.each(["in", "out"] as const)(
    "allows a card for external cash transfers %s",
    async (direction) => {
      const user = userEvent.setup();
      render(
        <TestForm
          activityType={direction === "in" ? "TRANSFER_IN" : "TRANSFER_OUT"}
          isExternal
          direction={direction}
        />,
      );
      const label = direction === "in" ? "To Account" : "From Account";
      await user.click(screen.getByRole("combobox", { name: label }));
      expect(await screen.findByRole("option", { name: /^Card/ })).toBeInTheDocument();
    },
  );

  it.each(["From Account", "To Account"])("excludes cards from securities %s", async (label) => {
    const user = userEvent.setup();
    render(<TestForm transferMode="securities" />);
    await user.click(screen.getByRole("combobox", { name: label }));
    expect(await screen.findByRole("option", { name: /Brokerage/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Card/ })).toBeNull();
  });

  it.each(["From Account", "To Account"])(
    "updates %s when switching transfer modes",
    async (label) => {
      const user = userEvent.setup();
      render(<TestForm />);
      for (const mode of ["Securities", "Cash"]) {
        await user.click(screen.getByRole("button", { name: mode }));
        await user.click(screen.getByRole("combobox", { name: label }));
        expect(await screen.findByRole("option", { name: /Brokerage/ })).toBeInTheDocument();
        if (mode === "Cash") {
          expect(screen.getByRole("option", { name: /^Card/ })).toBeInTheDocument();
        } else {
          expect(screen.queryByRole("option", { name: /Card/ })).toBeNull();
        }
        await user.click(screen.getByRole("button", { name: "Back" }));
      }
    },
  );

  it("keeps cards blocked for non-transfer activities", async () => {
    const user = userEvent.setup();
    render(<TestForm activityType="BUY" />);
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    expect(await screen.findByRole("option", { name: /Brokerage/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Card/ })).toBeNull();
  });
});
