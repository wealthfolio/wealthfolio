// A direct load of /spending/transactions/new can mount the form before the
// accounts query has data. Uses the real useAccounts: its fallback while the
// query is pending must keep one identity, or the form's reset never settles.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test/render";
import { CashActivityForm } from "./cash-activity-form";

const accountsQuery = vi.hoisted(() => ({ pending: true }));

vi.mock("@/adapters", () => ({
  getAccounts: vi.fn(() =>
    accountsQuery.pending
      ? new Promise(() => undefined)
      : Promise.resolve([
          {
            id: "chequing",
            name: "Chequing",
            currency: "CAD",
            accountType: "CASH",
            isActive: true,
          },
        ]),
  ),
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/hooks/use-settings", () => {
  const data = { baseCurrency: "CAD" };
  return { useSettings: () => ({ data }) };
});
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => false,
  usePlatform: () => ({ isIOS: false }),
}));
vi.mock("@/hooks/use-taxonomies", () => {
  const result = { data: null };
  return { useTaxonomy: () => result };
});
vi.mock("../hooks/use-spending-settings", () => {
  const settings = { accountIds: ["chequing"] };
  return { useSpendingSettings: () => ({ settings }) };
});
vi.mock("../hooks/use-spending-events", () => {
  const empty = { data: [] };
  return { useSpendingEvents: () => empty, useEventTypes: () => empty };
});
vi.mock("./event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn(), openEventTypeDialog: vi.fn() }),
}));

function makeWrapper(seedAccounts: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedAccounts) {
    queryClient.setQueryData(
      ["accounts", false],
      [
        {
          id: "chequing",
          name: "Chequing",
          currency: "CAD",
          accountType: "CASH",
          isActive: true,
        },
      ],
    );
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("CashActivityForm direct entry while accounts load", () => {
  // Used to fail with "Maximum update depth exceeded" (React #185 in production).
  it("renders before the accounts query has data", () => {
    accountsQuery.pending = true;
    render(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />, {
      wrapper: makeWrapper(false),
    });
    expect(screen.getByRole("combobox", { name: "Account" })).toBeInTheDocument();
  });

  // Control: the same mount with the accounts already cached settles.
  it("renders when the accounts are already cached", () => {
    accountsQuery.pending = true;
    render(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />, {
      wrapper: makeWrapper(true),
    });
    expect(screen.getByRole("combobox", { name: "Account" })).toBeInTheDocument();
  });
});
