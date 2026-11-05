import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { FormProvider, useForm } from "react-hook-form";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkHoldingsForm } from "./bulk-holdings-form";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => viewport.mobile }));
const inventory = vi.hoisted(() => ({ accounts: [] as Record<string, unknown>[] }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: inventory.accounts }) }));
vi.mock("@/components/account-selector", () => ({ AccountSelector: () => null }));
vi.mock("@/components/ticker-search", () => ({ default: () => null }));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));

const account = (id: string, accountType: string, trackingMode: string) => ({
  id,
  name: id,
  accountType,
  trackingMode,
  currency: "EUR",
  isActive: true,
});

function FormWrapper({
  children,
  accountId = "account-1",
}: {
  children: ReactNode;
  accountId?: string;
}) {
  const form = useForm({
    defaultValues: {
      accountId,
      activityDate: new Date(2026, 9, 14),
      currency: "EUR",
      holdings: [{ id: "holding-1", ticker: "SAP", sharesOwned: 10, averageCost: 123.45 }],
    },
  });
  return <FormProvider {...form}>{children}</FormProvider>;
}

describe("BulkHoldingsForm", () => {
  afterEach(() => {
    viewport.mobile = false;
    inventory.accounts = [];
  });

  it("formats each row total in the form's currency", () => {
    render(
      <FormattingProvider locale="DE">
        <FormWrapper>
          <BulkHoldingsForm />
        </FormWrapper>
      </FormattingProvider>,
    );

    expect(screen.getByText(/^1\.234,50\s€$/)).toBeInTheDocument();
  });

  it("lays out a phone form as cards of labelled rows", () => {
    viewport.mobile = true;
    render(
      <FormattingProvider locale="DE">
        <FormWrapper>
          <BulkHoldingsForm />
        </FormWrapper>
      </FormattingProvider>,
    );

    const groups = document.querySelectorAll('[data-slot="form-row-group"]');
    // Account and date, then the one holding.
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContainElement(screen.getByRole("combobox", { name: /account/i }));
    expect(groups[1]).toContainElement(screen.getByLabelText(/shares/i));
    expect(groups[1]).toContainElement(screen.getByLabelText(/average cost/i));
    expect(screen.getByText(/^1\.234,50\s€$/)).toBeInTheDocument();
    // A lone holding has nothing to remove it for.
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("offers on phones the accounts the desktop account selector offers", async () => {
    viewport.mobile = true;
    inventory.accounts = [
      account("Brokerage", "SECURITIES", "TRANSACTIONS"),
      account("Snapshot broker", "SECURITIES", "HOLDINGS"),
      account("Card", "CREDIT_CARD", "TRANSACTIONS"),
    ];
    const user = userEvent.setup();
    render(
      <FormattingProvider locale="DE">
        <FormWrapper accountId="">
          <BulkHoldingsForm />
        </FormWrapper>
      </FormattingProvider>,
    );

    await user.click(screen.getByRole("combobox", { name: /account/i }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options.some((text) => text?.includes("Brokerage"))).toBe(true);
    expect(options.some((text) => text?.includes("Snapshot broker"))).toBe(false);
    expect(options.some((text) => text?.includes("Card"))).toBe(false);
  });

  it("names the form's account on phones even when the filter leaves it out", () => {
    viewport.mobile = true;
    const inactive = { ...account("Old brokerage", "SECURITIES", "TRANSACTIONS"), isActive: false };
    render(
      <FormattingProvider locale="DE">
        <FormWrapper accountId="Old brokerage">
          <BulkHoldingsForm defaultAccount={inactive as never} />
        </FormWrapper>
      </FormattingProvider>,
    );

    expect(screen.getByRole("combobox", { name: /account/i })).toHaveTextContent("Old brokerage");
  });
});
