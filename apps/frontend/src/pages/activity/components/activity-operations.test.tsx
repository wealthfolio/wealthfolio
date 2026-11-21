import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ActivityDetails } from "@/lib/types";
import { render, screen } from "@/test/render";
import { ActivityOperations } from "./activity-operations";

// The sheets the menu can open are not under test.
vi.mock("./activity-detail-sheet", () => ({ ActivityDetailSheet: () => null }));
vi.mock("@/pages/asset/alternative-assets/components/activity-loan-payment-sheet", () => ({
  ActivityLoanPaymentSheet: () => null,
}));

const credit = {
  id: "credit-1",
  accountId: "acct",
  activityType: "CREDIT",
  amount: "450",
  currency: "CAD",
} as unknown as ActivityDetails;

describe("ActivityOperations", () => {
  // A payment saved as a card's refund/credit becomes the card's payment (#2740).
  it.each([
    ["CREDIT_CARD", true],
    ["CASH", false],
  ])("offers a %s account's credit Make it a transfer: %s", async (accountType, offered) => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActivityOperations
        activity={credit}
        accountType={accountType}
        onEdit={handler}
        onDelete={handler}
        onDuplicate={handler}
        onLinkTransfer={handler}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^open$/i }));
    await screen.findByRole("menuitem", { name: /edit/i });

    expect(!!screen.queryByRole("menuitem", { name: /Make it a transfer/ })).toBe(offered);
  });
});
