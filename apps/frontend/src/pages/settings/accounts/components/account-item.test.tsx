import { render, screen } from "@/test/render";
import type { Account } from "@/lib/types";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AccountItem } from "./account-item";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function renderItem(overrides: Partial<Account> = {}) {
  const account = {
    id: "acc-1",
    name: "Checking",
    accountType: "CASH",
    group: "Banks",
    currency: "EUR",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    ...overrides,
  } as Account;
  render(
    <MemoryRouter>
      <AccountItem
        account={account}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onHide={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("AccountItem account number", () => {
  it("shows the end of the number after the currency and group", () => {
    renderItem({ accountNumber: "DE89 3704 0044 0532 0130 00" });
    const number = screen.getByTestId("account-item-number");
    expect(number).toHaveTextContent("··3000");
    expect(number).toHaveAttribute("dir", "ltr");
    // Never the whole number.
    expect(screen.queryByText(/3704/)).not.toBeInTheDocument();
  });

  it("shows a broker-synced account's number the same way", () => {
    renderItem({ accountNumber: "U1234001", providerAccountId: "broker-1" });
    expect(screen.getByTestId("account-item-number")).toHaveTextContent("··4001");
  });

  it("shows nothing for an account without a number", () => {
    renderItem({ accountNumber: undefined });
    expect(screen.queryByTestId("account-item-number")).not.toBeInTheDocument();
  });
});
