import type { ActivityDetails } from "@/lib/types";
import { render, screen, within } from "@testing-library/react";
import { DirectionProvider, FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import { ActivityDetailSheet, ActivityReviewReasons } from "./activity-detail-sheet";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => privacy }));

describe("ActivityReviewReasons", () => {
  it("shows provider-supplied reasons for an activity needing review", () => {
    render(
      <ActivityReviewReasons
        activity={{
          needsReview: true,
          metadata: {
            mapping_reasons: ["Provider could not supply a market value"],
          },
        }}
      />,
    );

    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByText("Provider could not supply a market value")).toBeInTheDocument();
  });

  it("does not show stale provider reasons after review is complete", () => {
    render(
      <ActivityReviewReasons
        activity={{
          needsReview: false,
          metadata: { mapping_reasons: ["Previously required review"] },
        }}
      />,
    );

    expect(screen.queryByText("Previously required review")).not.toBeInTheDocument();
  });
});

describe("ActivityDetailSheet", () => {
  const chargedActivity = {
    id: "charged-buy",
    activityType: "BUY",
    date: "2026-01-02T12:00:00Z",
    quantity: "1",
    unitPrice: "100",
    amount: "107",
    fee: "5",
    tax: "2",
    currency: "USD",
    metadata: {
      charges: [
        { category: "fee", label: "Statement commission", amount: "5" },
        { category: "tax", label: "Statement stamp duty", amount: "2" },
      ],
    },
  } as unknown as ActivityDetails;

  it("shows matching fee and tax lines in an RTL sheet and hides stale lines", () => {
    const { rerender } = render(
      <DirectionProvider direction="rtl">
        <FormattingProvider locale="US">
          <ActivityDetailSheet activity={chargedActivity} open onOpenChange={vi.fn()} />
        </FormattingProvider>
      </DirectionProvider>,
    );

    const commission = screen.getByText("Statement commission").parentElement!;
    expect(commission).toHaveClass("ps-4");
    expect(within(commission).getByText(/\$5\.00/)).toBeInTheDocument();
    const tax = screen.getByText("Statement stamp duty").parentElement!;
    expect(within(tax).getByText(/\$2\.00/)).toBeInTheDocument();

    rerender(
      <DirectionProvider direction="rtl">
        <FormattingProvider locale="US">
          <ActivityDetailSheet
            activity={{ ...chargedActivity, fee: "6" }}
            open
            onOpenChange={vi.fn()}
          />
        </FormattingProvider>
      </DirectionProvider>,
    );
    expect(screen.queryByText("Statement commission")).not.toBeInTheDocument();
    expect(screen.queryByText("Statement stamp duty")).not.toBeInTheDocument();
  });

  it("shows zero-sum lines and hides their amounts when balances are private", () => {
    privacy.isBalanceHidden = true;
    try {
      render(
        <FormattingProvider locale="US">
          <ActivityDetailSheet
            activity={{
              ...chargedActivity,
              fee: "0",
              tax: "0",
              metadata: {
                charges: [
                  { category: "fee", label: "Statement commission", amount: "5" },
                  { category: "fee", label: "Commission rebate", amount: "-5" },
                  { category: "tax", label: "Waived tax", amount: "0" },
                ],
              },
            }}
            open
            onOpenChange={vi.fn()}
          />
        </FormattingProvider>,
      );
      for (const label of ["Statement commission", "Commission rebate", "Waived tax"]) {
        const row = screen.getByText(label).parentElement!;
        expect(row).toBeInTheDocument();
        expect(within(row).getByText("••••")).toBeInTheDocument();
      }
    } finally {
      privacy.isBalanceHidden = false;
    }
  });

  it("shows an option's strike in its quote currency, not the activity currency", () => {
    const activity = {
      id: "option-buy",
      activityType: "BUY",
      date: "2026-01-02T12:00:00Z",
      quantity: "1",
      unitPrice: "7",
      amount: "700",
      currency: "CAD",
      assetSymbol: "AAPL260619C00150000",
      assetQuoteCcy: "USD",
      instrumentType: "OPTION",
    } as unknown as ActivityDetails;

    render(
      <FormattingProvider locale="US">
        <ActivityDetailSheet activity={activity} open onOpenChange={vi.fn()} />
      </FormattingProvider>,
    );

    expect(screen.getByText("Jun 19 $150.00 CALL")).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(screen.queryByText("CA$150.00")).not.toBeInTheDocument();
  });
});
