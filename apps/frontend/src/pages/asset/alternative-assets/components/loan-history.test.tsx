import { render, screen } from "@/test/render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";
import { LoanHistory } from "./loan-history";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("./loan-terms-strip", () => ({ LoanTermsStrip: () => null }));

const holding = {
  id: "loan",
  kind: "liability",
  currency: "USD",
  marketValue: -900,
  metadata: { sub_type: "personal", origination_date: "2025-01-01", original_amount: "1000" },
} as unknown as AlternativeAssetHolding;

const quote = (timestamp: string, close: number, notes: string) =>
  ({ id: timestamp, timestamp, close, notes }) as unknown as Quote;

const actions = {
  renew: vi.fn(),
  confirmBalance: vi.fn(),
  editEvent: vi.fn(),
  editBalance: vi.fn(),
} as unknown as LoanActionCallbacks;

describe("loan history", () => {
  it("shows the note a user added to a confirmed balance or extra repayment", () => {
    render(
      <MemoryRouter>
        <LoanHistory
          holding={holding}
          calculation={null}
          quotes={[
            quote(
              "2025-03-01T00:00:00Z",
              -950,
              "loan_event|type=balance_correction|note=From%20the%20statement",
            ),
            quote(
              "2025-04-01T00:00:00Z",
              -900,
              "loan_event|type=extra_repayment|note=Bonus%20%7C%20June",
            ),
            quote("2025-05-01T00:00:00Z", -890, "loan_event|type=extra_repayment"),
          ]}
          actions={actions}
          onEditDetails={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("From the statement")).toBeInTheDocument();
    expect(screen.getByText("Bonus | June")).toBeInTheDocument();
    expect(screen.queryByText(/loan_event/)).not.toBeInTheDocument();
  });
});
