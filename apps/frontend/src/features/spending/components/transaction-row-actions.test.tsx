import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types";
import { render, screen } from "@/test/render";
import type { TransactionRowVM } from "../lib/transactions-helpers";
import { TransactionRowActions } from "./transaction-row-actions";

function renderMenu(accountType: string) {
  const row = {
    activity: {
      id: "credit-1",
      accountId: "acct",
      activityType: "CREDIT",
      amount: "450",
      currency: "CAD",
    },
    category: null,
    splitCount: 0,
    needsReview: false,
  } as unknown as TransactionRowVM;
  const handler = vi.fn();
  render(
    <TransactionRowActions
      row={row}
      account={{ id: "acct", accountType, currency: "CAD" } as Account}
      onMarkReimbursement={handler}
      onEditSplits={handler}
      onEdit={handler}
      onDuplicate={handler}
      onDelete={handler}
      onLinkTransfer={handler}
    />,
  );
}

describe("TransactionRowActions", () => {
  // A payment saved as a card's refund/credit becomes the card's payment (#2740).
  it.each([
    ["CREDIT_CARD", true],
    ["CASH", false],
  ])("offers a %s account's credit Make it a transfer: %s", async (accountType, offered) => {
    const user = userEvent.setup();
    renderMenu(accountType);
    await user.click(screen.getByRole("button", { name: /actions/i }));
    await screen.findByRole("menuitem", { name: /edit/i });

    expect(!!screen.queryByRole("menuitem", { name: /Make it a transfer/ })).toBe(offered);
  });
});
