import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import Balance from "./balance";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@number-flow/react", () => ({
  default: ({ locales }: { locales?: string }) => (
    <span data-testid="visible-balance-locale">{locales}</span>
  ),
}));

describe("Balance", () => {
  it("passes the selected formatting locale to the visible number", () => {
    render(
      <FormattingProvider locale="DE">
        <Balance targetValue={1234.56} currency="EUR" displayCurrency />
      </FormattingProvider>,
    );

    expect(screen.getByTestId("visible-balance-locale")).toHaveTextContent("de-DE");
  });
});
