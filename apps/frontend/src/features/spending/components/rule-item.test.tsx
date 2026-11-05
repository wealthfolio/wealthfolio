import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CategorizationRule } from "../types/rule";
import { FormattingProvider } from "@wealthfolio/ui";
import { RuleItem } from "./rule-item";

vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@wealthfolio/ui")>();
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...original,
    AlertDialog: Passthrough,
    AlertDialogAction: Passthrough,
    AlertDialogCancel: Passthrough,
    AlertDialogContent: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogHeader: Passthrough,
    AlertDialogTitle: Passthrough,
    Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuTrigger: Passthrough,
    Icons: new Proxy({}, { get: () => () => <span data-testid="icon" /> }),
  };
});

function rule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: "r1",
    name: "Coffee shops",
    pattern: "STARBUCKS",
    matchType: "contains",
    taxonomyId: null,
    categoryId: null,
    activityType: null,
    priority: 0,
    isGlobal: true,
    accountId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const renderRule = (r: CategorizationRule) =>
  render(<RuleItem rule={r} categoryMeta={{}} onEdit={vi.fn()} onDelete={vi.fn()} />);

describe("RuleItem amount condition display", () => {
  it("renders no amount chip when the rule has no condition", () => {
    renderRule(rule());
    expect(screen.queryByText(/^Amount /)).not.toBeInTheDocument();
  });

  it("spells out single-value operators in words", () => {
    renderRule(rule({ amountOp: "gt", amountValue: 1000 }));
    expect(screen.getByText("Amount greater than 1,000")).toBeInTheDocument();
  });

  it("spells out inclusive operators", () => {
    renderRule(rule({ amountOp: "gte", amountValue: 100 }));
    expect(screen.getByText("Amount 100 or more")).toBeInTheDocument();
  });

  it("spells out between with both bounds", () => {
    renderRule(rule({ amountOp: "between", amountValue: 45, amountValue2: 55 }));
    expect(screen.getByText("Amount between 45 and 55")).toBeInTheDocument();
  });

  it("spells out exact amounts including decimals", () => {
    renderRule(rule({ amountOp: "eq", amountValue: 25.5 }));
    expect(screen.getByText("Amount exactly 25.5")).toBeInTheDocument();
  });

  it("renders no chip for a malformed condition missing its value", () => {
    renderRule(rule({ amountOp: "gt", amountValue: null }));
    expect(screen.queryByText(/^Amount /)).not.toBeInTheDocument();
  });

  // The amount condition and the account scope are independent gates; a rule can
  // carry both, and each has its own chip.
  it("shows the amount chip alongside an account scope chip", () => {
    render(
      <RuleItem
        rule={rule({
          amountOp: "between",
          amountValue: 45,
          amountValue2: 55,
          isGlobal: false,
          accountId: "acct-1",
        })}
        categoryMeta={{}}
        accountMeta={{ "acct-1": "Everyday Checking" }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Amount between 45 and 55")).toBeInTheDocument();
    expect(screen.getByText("Everyday Checking")).toBeInTheDocument();
  });

  it("keeps the amount chip when the scoped account is unknown", () => {
    render(
      <RuleItem
        rule={rule({ amountOp: "gt", amountValue: 100, isGlobal: false, accountId: "gone" })}
        categoryMeta={{}}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Amount greater than 100")).toBeInTheDocument();
    expect(screen.getByText("Unknown account")).toBeInTheDocument();
  });
});

it("uses the formatting region for rule amounts while the language stays English", () => {
  render(
    <FormattingProvider locale="ES">
      <RuleItem
        rule={rule({ amountOp: "eq", amountValue: 12345.67 })}
        categoryMeta={{}}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </FormattingProvider>,
  );
  expect(screen.getByText("Amount exactly 12.345,67")).toBeInTheDocument();
});
