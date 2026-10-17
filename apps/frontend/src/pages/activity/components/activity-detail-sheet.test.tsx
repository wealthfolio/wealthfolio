import type { ActivityDetails } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import { ActivityDetailSheet, ActivityReviewReasons } from "./activity-detail-sheet";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

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
