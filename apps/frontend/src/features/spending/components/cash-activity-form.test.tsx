import { render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateActivity } from "@/adapters";
import type { Activity } from "@/lib/types";
import { CashActivityForm } from "./cash-activity-form";

async function chooseAccount(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(await screen.findByRole("option", { name }));
}

vi.mock("@/adapters", () => ({
  createActivity: vi.fn(),
  updateActivity: vi.fn((payload: unknown) => Promise.resolve(payload)),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Each factory builds its value ONCE and hands back the same reference. The
// real hooks are React Query-backed and stable; a mock that returns a fresh
// array every render makes `spendingAccounts` a new identity each pass, which
// re-fires the reset effect that depends on it and never settles.
vi.mock("@/hooks/use-accounts", () => {
  const accounts = [
    {
      id: "card",
      name: "WS Visa Infinite",
      currency: "CAD",
      accountType: "CREDIT_CARD",
      isActive: true,
    },
    { id: "euro", name: "Spending Euro", currency: "EUR", accountType: "CASH", isActive: true },
    { id: "chequing", name: "WS Chequing", currency: "CAD", accountType: "CASH", isActive: true },
  ];
  return { useAccounts: () => ({ accounts }) };
});
vi.mock("@/hooks/use-settings", () => {
  const data = { baseCurrency: "CAD" };
  return { useSettings: () => ({ data }) };
});
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/hooks/use-taxonomies", () => {
  const result = { data: null };
  return { useTaxonomy: () => result };
});
vi.mock("../hooks/use-spending-settings", () => {
  const settings = { accountIds: ["card", "euro", "chequing"] };
  return { useSpendingSettings: () => ({ settings }) };
});
vi.mock("../hooks/use-spending-events", () => {
  const empty = { data: [] };
  return { useSpendingEvents: () => empty, useEventTypes: () => empty };
});
vi.mock("./event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn(), openEventTypeDialog: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** A charge made abroad: booked in USD on a card denominated in CAD. */
const foreignCharge = {
  id: "act-1",
  accountId: "card",
  activityType: "WITHDRAWAL",
  activityDate: "2026-07-13T12:00:00.000Z",
  amount: "9.59",
  currency: "USD",
  fxRate: "1.37",
  notes: "Sq *Morning Owl",
} as unknown as Activity;

describe("CashActivityForm currency", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The currency used to be recomputed from the account on every save. Saving
   * an untouched foreign charge therefore rewrote it to the account's own
   * currency — the amount stayed 9.59 while its meaning changed from USD to
   * CAD, with nothing on screen to show it had happened.
   */
  it("keeps an existing activity's own currency when nothing was edited", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      id: "act-1",
      currency: "USD",
    });
  });

  it("carries the activity's FX rate through an untouched save", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({ fxRate: 1.37 });
  });

  it("clears the FX rate when the activity currency changes", async () => {
    const user = userEvent.setup();
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={{ ...foreignCharge, accountId: "euro" } as unknown as Activity}
      />,
      { wrapper },
    );

    await user.click(screen.getByTestId("advanced-options-button"));
    await user.click(screen.getByRole("button", { name: "CAD" }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "euro",
      currency: "CAD",
      fxRate: null,
    });
  });

  /**
   * An FX rate converts the activity's currency into the ACCOUNT's. Moving the
   * activity to an account with a different denomination leaves the rate
   * describing a pair that no longer exists — and the field is collapsed by
   * default, so a USD->CAD rate would be silently reread as USD->EUR.
   */
  it("clears the FX rate when the activity moves to a differently-denominated account", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await chooseAccount(user, /Spending Euro/);
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "euro",
      currency: "USD",
      fxRate: null,
    });
  });

  /** The opposite case: same denomination, so the rate still describes the pair. */
  it("keeps the FX rate when the new account has the same currency", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await chooseAccount(user, /WS Chequing/);
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "chequing",
      currency: "USD",
      fxRate: 1.37,
    });
  });

  /**
   * The rate only describes a conversion when one happened. Keeping a stale one
   * on a same-currency row would have the server multiply by it.
   */
  it("drops the FX rate when the activity is in the account's own currency", async () => {
    const user = userEvent.setup();
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={{ ...foreignCharge, currency: "CAD" } as unknown as Activity}
      />,
      { wrapper },
    );

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      currency: "CAD",
      fxRate: null,
    });
  });
});
