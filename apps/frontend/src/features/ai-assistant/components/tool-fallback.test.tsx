import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ToolCallPart, ToolFallback } from "./tool-fallback";

const registeredCards = vi.hoisted(() => ({
  toolUIs: {} as Record<string, { render: unknown }[]>,
}));

vi.mock("@assistant-ui/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react")>()),
  useAuiState: (select: (state: { tools: typeof registeredCards }) => unknown) =>
    select({ tools: registeredCards }),
}));

type Props = ComponentProps<typeof ToolFallback>;

function toolProps(toolName: string, result: unknown): Props {
  return {
    toolName,
    argsText: "{}",
    result,
    status: { type: "complete" },
  } as unknown as Props;
}

describe("ToolFallback", () => {
  it("shows a successful call as used", () => {
    render(<ToolFallback {...toolProps("get_accounts", { accounts: [] })} />);

    expect(screen.getByText("Used tool: get_accounts")).toBeInTheDocument();
  });

  it("shows a skipped or failed call as not used, with its reason", () => {
    render(
      <ToolFallback
        {...toolProps("get_accounts", {
          error: "Skipped: this turn reached its tool-call limit.",
        })}
      />,
    );

    expect(screen.queryByText("Used tool: get_accounts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Tool not used: get_accounts"));
    expect(screen.getByText("Skipped: this turn reached its tool-call limit.")).toBeInTheDocument();
  });
});

describe("ToolCallPart", () => {
  registeredCards.toolUIs = {
    get_performance: [{ render: () => <p>Performance card</p> }],
    import_csv: [{ render: () => <p>Import card</p> }],
  };

  it("renders a call's registered card", () => {
    render(<ToolCallPart {...toolProps("get_performance", { returns: [] })} />);

    expect(screen.getByText("Performance card")).toBeInTheDocument();
  });

  it("renders a call that did not run as not used instead of its card", () => {
    render(<ToolCallPart {...toolProps("get_performance", { error: "Skipped" })} />);

    expect(screen.queryByText("Performance card")).not.toBeInTheDocument();
    expect(screen.getByText("Tool not used: get_performance")).toBeInTheDocument();
  });

  it("keeps the import card, which explains its own errors", () => {
    render(<ToolCallPart {...toolProps("import_csv", { error: "No attached CSV file" })} />);

    expect(screen.getByText("Import card")).toBeInTheDocument();
  });

  it("falls back for a tool without a card", () => {
    render(<ToolCallPart {...toolProps("get_spending", { total: 1 })} />);

    expect(screen.getByText("Used tool: get_spending")).toBeInTheDocument();
  });
});
