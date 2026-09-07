import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useSpendingSettings,
  useSpendingSettingsMutation,
} from "@/features/spending/hooks/use-spending-settings";
import { useAccounts } from "@/hooks/use-accounts";
import { AccountType } from "@/lib/constants";
import type { Account, TrackingMode } from "@/lib/types";

import { AccountsCard } from "./accounts-card";

vi.mock("@wealthfolio/ui", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Icons: {
    AlertTriangle: () => <span />,
    CreditCard: () => <span />,
    Wallet: () => <span />,
  },
  Switch: ({ checked, "aria-label": ariaLabel }: { checked: boolean; "aria-label"?: string }) => (
    <button type="button" role="switch" aria-checked={checked} aria-label={ariaLabel} />
  ),
  useLocalizationSettings: () => ({ locale: "en-US", uiLocale: "en" }),
}));

vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: vi.fn(),
  useSpendingSettingsMutation: vi.fn(),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: vi.fn(),
}));

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseSpendingSettings = vi.mocked(useSpendingSettings);
const mockUseSpendingSettingsMutation = vi.mocked(useSpendingSettingsMutation);

function createAccount(overrides: Partial<Account>): Account {
  return {
    id: overrides.id ?? "account-1",
    name: overrides.name ?? "Account 1",
    accountType: overrides.accountType ?? AccountType.CASH,
    group: overrides.group,
    balance: overrides.balance ?? 0,
    currency: overrides.currency ?? "USD",
    isDefault: overrides.isDefault ?? false,
    isActive: overrides.isActive ?? true,
    isArchived: overrides.isArchived ?? false,
    trackingMode: overrides.trackingMode ?? ("TRANSACTIONS" as TrackingMode),
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
    platformId: overrides.platformId,
    accountNumber: overrides.accountNumber,
    meta: overrides.meta,
    provider: overrides.provider,
    providerAccountId: overrides.providerAccountId,
  };
}

function mockSettings(accountIds: string[]) {
  mockUseSpendingSettings.mockReturnValue({
    settings: {
      enabled: true,
      accountIds,
    },
    isEnabled: true,
    accountIds,
    isLoading: false,
    error: null,
  });
}

function rowNames() {
  return screen
    .getAllByText(/Business Saving|Credit Card|Saving account/)
    .map((node) => node.textContent);
}

describe("AccountsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccounts.mockReturnValue({
      accounts: [
        createAccount({ id: "business", name: "Business Saving", group: "Business" }),
        createAccount({
          id: "credit-card",
          name: "Credit Card",
          accountType: AccountType.CREDIT_CARD,
        }),
        createAccount({ id: "saving", name: "Saving account", group: "Cash" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    mockUseSpendingSettingsMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSpendingSettingsMutation>);
  });

  it("sorts initially tracked accounts first without moving newly tracked rows", () => {
    mockSettings(["saving"]);

    const { rerender } = render(<AccountsCard />);

    expect(rowNames()).toEqual(["Saving account", "Business Saving", "Credit Card"]);

    mockSettings(["saving", "credit-card"]);
    rerender(<AccountsCard />);

    expect(rowNames()).toEqual(["Saving account", "Business Saving", "Credit Card"]);
  });
});
