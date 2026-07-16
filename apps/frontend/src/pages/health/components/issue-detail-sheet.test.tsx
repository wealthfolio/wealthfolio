import type { HealthIssue } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { IssueDetailSheet } from "./issue-detail-sheet";

const diagnosticMeta = {
  fingerprint: "diagnostic-fingerprint",
  domain: "performanceInputs" as const,
  level: "source" as const,
  severity: "WARNING" as const,
  entities: [],
};

vi.mock("@wealthfolio/ui", () => ({
  ActionConfirm: ({ button }: { button: React.ReactNode }) => <>{button}</>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => {
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, props);
    }
    return (
      <button type="button" {...props}>
        {children}
      </button>
    );
  },
  Icons: {
    ArrowRight: () => <span>ArrowRight</span>,
    ChevronRight: () => <span>ChevronRight</span>,
    EyeOff: () => <span>EyeOff</span>,
    Spinner: () => <span>Spinner</span>,
    Wand2: () => <span>Wand2</span>,
  },
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="sheet-content" className={className}>
      {children}
    </div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const baseIssue: HealthIssue = {
  id: "timezone_missing:abc123",
  severity: "WARNING",
  category: "SETTINGS_CONFIGURATION",
  title: "Timezone not configured",
  message: "Set your timezone in General settings to ensure dates match your locale.",
  affectedCount: 1,
  dataHash: "abc123",
  timestamp: "2026-03-01T00:00:00Z",
  navigateAction: {
    route: "/settings/general",
    label: "Open General Settings",
  },
};

const noop = () => undefined;

function renderIssueSheet(issue: HealthIssue) {
  render(
    <MemoryRouter initialEntries={["/health"]}>
      <Routes>
        <Route
          path="/health"
          element={
            <IssueDetailSheet
              issue={issue}
              open={true}
              onOpenChange={noop}
              onDismiss={noop}
              onFix={noop}
              onRunFixAction={noop}
              isDismissing={false}
              isFixing={false}
            />
          }
        />
        <Route path="/settings/general" element={<div>General Settings Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("IssueDetailSheet", () => {
  it("shows timezone-specific category and copy for timezone issues", () => {
    renderIssueSheet(baseIssue);

    expect(screen.getAllByText("Timezone Settings").length).toBeGreaterThan(0);
    expect(screen.getByText(/Your app timezone is not configured/i)).toBeInTheDocument();
  });

  it("navigates with router link for General Settings action", async () => {
    const user = userEvent.setup();
    renderIssueSheet(baseIssue);

    await user.click(screen.getByRole("link", { name: /Open General Settings/i }));

    expect(screen.getByText("General Settings Page")).toBeInTheDocument();
  });

  it("keeps long issue details inside the scrollable body", () => {
    renderIssueSheet({
      ...baseIssue,
      category: "DATA_CONSISTENCY",
      title: "9 transfers need matching or confirmation",
      message: "Some transfers are missing the other side of the move.",
      affectedCount: 9,
      affectedItems: Array.from({ length: 9 }, (_, index) => ({
        id: `transfer-${index}`,
        name: `Transfer ${index + 1} needs review`,
      })),
      details: Array.from(
        { length: 9 },
        (_, index) =>
          `Transfer ${index + 1} needs review\nMatch this with the other side of the transfer, or mark it external if money entered or left your portfolio.`,
      ).join("\n\n"),
    });

    const scrollArea = screen.getByTestId("scroll-area");

    expect(scrollArea).toHaveClass("min-h-0", "flex-1");
    expect(scrollArea).toContainElement(screen.getByText("Details"));
    expect(scrollArea).toContainElement(screen.getByText("About this issue"));
    expect(scrollArea).not.toContainElement(
      screen.getByRole("link", { name: /Open General Settings/i }),
    );
  });

  it("uses a wider responsive sheet for dense issue details", () => {
    renderIssueSheet({
      ...baseIssue,
      category: "DATA_CONSISTENCY",
      title: "7 transfers need matching or confirmation",
      affectedCount: 7,
    });

    expect(screen.getByTestId("sheet-content")).toHaveClass("sm:max-w-xl", "lg:max-w-2xl");
  });

  it("highlights individual detail entries and date lines", () => {
    renderIssueSheet({
      ...baseIssue,
      category: "DATA_CONSISTENCY",
      title: "2 transfer dates need review",
      details: "Personal\nDate: 2023-02-20\n\nPersonal\nDate: 2025-03-02",
    });

    expect(screen.getByText("Date: 2023-02-20")).toHaveClass("font-mono", "tabular-nums");
    expect(screen.getByText("Date: 2025-03-02")).toHaveClass("font-mono", "tabular-nums");
  });

  it("keeps legacy details visible for fallback diagnostics", () => {
    const message =
      "One or more accounts show a negative total value in their history. This is usually caused by missing buy transactions. Review your activities to fix this.";
    renderIssueSheet({
      ...baseIssue,
      id: "negative_account_balance:abc123",
      category: "DATA_CONSISTENCY",
      title: "Account has negative portfolio balance",
      message,
      details:
        "TFSA\nFirst went negative on 2026-06-01.\nCash: -100.00 CAD | Investments: 50.00 CAD\nLikely missing Transfer In or deposit before a buy transaction.",
      diagnostics: [
        {
          ...diagnosticMeta,
          fingerprint: "fallback",
          domain: "ledger",
          code: "NEGATIVE_ACCOUNT_BALANCE",
          title: "Account has negative portfolio balance",
          explanation: message,
          evidence: [{ label: "Item", value: "TFSA" }],
          actions: [],
        },
      ],
    });

    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("First went negative on 2026-06-01.")).toBeInTheDocument();
    expect(screen.getByText(/Likely missing Transfer In/i)).toBeInTheDocument();
  });

  it("serializes filtered activity navigation query params", () => {
    renderIssueSheet({
      ...baseIssue,
      category: "DATA_CONSISTENCY",
      title: "2 transfer dates need review",
      navigateAction: {
        route: "/activities",
        label: "Review Transactions",
        query: {
          account: "acc-personal",
          types: "TRANSFER_IN,TRANSFER_OUT",
          from: "2023-02-20",
          to: "2025-03-02",
          q: "InternalSecurityTransfer",
        },
      },
    });

    const href = screen.getByRole("link", { name: /Review Transactions/i }).getAttribute("href");
    const url = new URL(href ?? "", "http://localhost");

    expect(url.pathname).toBe("/activities");
    expect(url.searchParams.get("account")).toBe("acc-personal");
    expect(url.searchParams.get("types")).toBe("TRANSFER_IN,TRANSFER_OUT");
    expect(url.searchParams.get("from")).toBe("2023-02-20");
    expect(url.searchParams.get("to")).toBe("2025-03-02");
    expect(url.searchParams.get("q")).toBe("InternalSecurityTransfer");
  });

  it("links date detail cards to the exact activity date", () => {
    renderIssueSheet({
      ...baseIssue,
      category: "DATA_CONSISTENCY",
      title: "2 transfer dates need review",
      details: "Personal\nDate: 2023-02-20\n\nPersonal\nDate: 2025-03-02",
      navigateAction: {
        route: "/activities",
        label: "Review Transactions",
        query: {
          account: "acc-personal",
          types: "TRANSFER_IN,TRANSFER_OUT",
          from: "2023-02-20",
          to: "2025-03-02",
          q: "InternalSecurityTransfer",
        },
      },
    });

    const firstDetailLink = screen.getByText("Date: 2023-02-20").closest("a");
    const secondDetailLink = screen.getByText("Date: 2025-03-02").closest("a");
    const firstUrl = new URL(firstDetailLink?.getAttribute("href") ?? "", "http://localhost");
    const secondUrl = new URL(secondDetailLink?.getAttribute("href") ?? "", "http://localhost");

    expect(firstUrl.pathname).toBe("/activities");
    expect(firstUrl.searchParams.get("from")).toBe("2023-02-20");
    expect(firstUrl.searchParams.get("to")).toBe("2023-02-20");
    expect(firstUrl.searchParams.get("q")).toBe("InternalSecurityTransfer");
    expect(secondUrl.pathname).toBe("/activities");
    expect(secondUrl.searchParams.get("from")).toBe("2025-03-02");
    expect(secondUrl.searchParams.get("to")).toBe("2025-03-02");
    expect(secondUrl.searchParams.get("account")).toBe("acc-personal");
  });

  const diagnosticIssue: HealthIssue = {
    ...baseIssue,
    id: "incomplete_valuation_value:xyz",
    category: "DATA_CONSISTENCY",
    title: "55 prices or values are missing",
    message: "Some holdings are missing a market price, manual value, or exchange rate.",
    navigateAction: { route: "/activities", label: "Review Transactions" },
    details: "Trade Republic\nDate: 2025-11-05",
    diagnostics: [
      {
        ...diagnosticMeta,
        code: "INCOMPLETE_BASIS_ACTIVITY",
        title: "Missing purchase price",
        explanation: "This buy has no price, so its cost can't be calculated.",
        evidence: [
          { label: "Asset", value: "CGX — Cineplex Inc.", route: "/holdings/asset_cgx" },
          { label: "Trade date", value: "2020-06-22" },
        ],
        actions: [
          {
            primary: true,
            kind: "navigate",
            route: "/activities",
            query: { activity: "buy-1", healthContext: "activity" },
            label: "Review Transaction",
          },
          {
            primary: false,
            kind: "fix",
            id: "rebuild_account_history",
            label: "Rebuild History",
            payload: ["acc-1"],
          },
        ],
      },
    ],
  };

  it("renders a compact root cause with one deep-linked row per item, no technical labels", () => {
    render(
      <MemoryRouter>
        <IssueDetailSheet
          issue={diagnosticIssue}
          open={true}
          onOpenChange={noop}
          onDismiss={noop}
          onFix={noop}
          onRunFixAction={noop}
          isDismissing={false}
          isFixing={false}
        />
      </MemoryRouter>,
    );

    // Root cause is shown once; the item row shows the asset + trade date.
    expect(screen.getByText("Missing purchase price")).toBeInTheDocument();
    expect(screen.getByText(/no price/i)).toBeInTheDocument();
    expect(screen.getByText("CGX — Cineplex Inc.")).toBeInTheDocument();
    expect(screen.getByText("2020-06-22")).toBeInTheDocument();
    // No technical code, no section headers, no legacy details.
    expect(screen.queryByText("INCOMPLETE_BASIS_ACTIVITY")).not.toBeInTheDocument();
    expect(screen.queryByText("Root cause")).not.toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    // Secondary actions remain available.
    expect(screen.getByRole("button", { name: /Rebuild History/i })).toBeInTheDocument();
    // The whole row links to the exact activity.
    const row = screen.getByText("CGX — Cineplex Inc.").closest("a");
    const url = new URL(row?.getAttribute("href") ?? "", "http://localhost");
    expect(url.pathname).toBe("/activities");
    expect(url.searchParams.get("activity")).toBe("buy-1");
    expect(url.searchParams.get("healthContext")).toBe("activity");
  });

  it("renders transfer date diagnostics as date-filtered transfer rows", () => {
    renderIssueSheet({
      ...baseIssue,
      severity: "ERROR",
      category: "DATA_CONSISTENCY",
      title: "2 transfer dates need review",
      message:
        "Some transfers are unclear: Wealthfolio cannot tell if money moved between your own accounts or entered/left your portfolio.",
      navigateAction: {
        route: "/activities",
        label: "Review Transactions",
        query: { types: "TRANSFER_IN,TRANSFER_OUT", healthContext: "activity" },
      },
      diagnostics: [
        {
          ...diagnosticMeta,
          fingerprint: "transfer-rrsp-2026-06-01",
          domain: "ledger",
          code: "TRANSFER_DATE_NEEDS_REVIEW",
          title: "Transfer needs review",
          explanation:
            "Review the transfers on this date. Match the two transactions if money moved between your accounts, or mark it external if money entered or left your portfolio.",
          evidence: [
            {
              label: "Transfer",
              value: "RRSP",
              route:
                "/activities?account=acc-rrsp&from=2026-06-01&to=2026-06-01&types=TRANSFER_IN%2CTRANSFER_OUT&healthContext=activity",
            },
            { label: "Date", value: "2026-06-01" },
          ],
          actions: [
            {
              primary: true,
              kind: "navigate",
              route: "/activities",
              query: {
                account: "acc-rrsp",
                from: "2026-06-01",
                to: "2026-06-01",
                types: "TRANSFER_IN,TRANSFER_OUT",
                healthContext: "activity",
              },
              label: "Review Transactions",
            },
          ],
        },
        {
          ...diagnosticMeta,
          fingerprint: "transfer-tfsa-2026-06-02",
          domain: "ledger",
          code: "TRANSFER_DATE_NEEDS_REVIEW",
          title: "Transfer needs review",
          explanation:
            "Review the transfers on this date. Match the two transactions if money moved between your accounts, or mark it external if money entered or left your portfolio.",
          evidence: [
            {
              label: "Transfer",
              value: "TFSA",
              route:
                "/activities?account=acc-tfsa&from=2026-06-02&to=2026-06-02&types=TRANSFER_IN%2CTRANSFER_OUT&healthContext=activity",
            },
            { label: "Date", value: "2026-06-02" },
          ],
          actions: [
            {
              primary: true,
              kind: "navigate",
              route: "/activities",
              query: {
                account: "acc-tfsa",
                from: "2026-06-02",
                to: "2026-06-02",
                types: "TRANSFER_IN,TRANSFER_OUT",
                healthContext: "activity",
              },
              label: "Review Transactions",
            },
          ],
        },
      ],
    });

    expect(screen.getByText("Transfer needs review")).toBeInTheDocument();
    expect(screen.queryByText("Item")).not.toBeInTheDocument();
    expect(screen.getAllByText("Transfer")).toHaveLength(2);
    expect(screen.getByText("2026-06-01")).toBeInTheDocument();
    expect(screen.getByText("2026-06-02")).toBeInTheDocument();

    const rrspUrl = new URL(
      screen.getByText("RRSP").closest("a")?.getAttribute("href") ?? "",
      "http://localhost",
    );
    expect(rrspUrl.pathname).toBe("/activities");
    expect(rrspUrl.searchParams.get("account")).toBe("acc-rrsp");
    expect(rrspUrl.searchParams.get("from")).toBe("2026-06-01");
    expect(rrspUrl.searchParams.get("to")).toBe("2026-06-01");
    expect(rrspUrl.searchParams.get("types")).toBe("TRANSFER_IN,TRANSFER_OUT");
    expect(rrspUrl.searchParams.get("healthContext")).toBe("activity");
  });

  it("runs the primary fix action from the diagnostic action button", async () => {
    const user = userEvent.setup();
    const onRunFixAction = vi.fn();
    const fixIssue: HealthIssue = {
      ...diagnosticIssue,
      diagnostics: [
        {
          ...diagnosticMeta,
          fingerprint: "market-quote",
          domain: "marketData",
          code: "MISSING_MARKET_QUOTE",
          title: "No price found",
          explanation: "We couldn't find a price for this holding.",
          evidence: [{ label: "Asset", value: "XYZ — Example Corp" }],
          actions: [
            {
              primary: true,
              kind: "fix",
              id: "sync_prices",
              label: "Sync Prices",
              payload: ["asset_xyz"],
            },
          ],
        },
      ],
    };
    render(
      <MemoryRouter>
        <IssueDetailSheet
          issue={fixIssue}
          open={true}
          onOpenChange={noop}
          onDismiss={noop}
          onFix={noop}
          onRunFixAction={onRunFixAction}
          isDismissing={false}
          isFixing={false}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Sync Prices/i }));

    expect(onRunFixAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sync_prices", payload: ["asset_xyz"] }),
    );
  });

  it("runs a secondary fix action from the diagnostic action list", async () => {
    const user = userEvent.setup();
    const onRunFixAction = vi.fn();
    render(
      <MemoryRouter>
        <IssueDetailSheet
          issue={diagnosticIssue}
          open={true}
          onOpenChange={noop}
          onDismiss={noop}
          onFix={noop}
          onRunFixAction={onRunFixAction}
          isDismissing={false}
          isFixing={false}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Rebuild History/i }));

    expect(onRunFixAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rebuild_account_history", payload: ["acc-1"] }),
    );
  });

  it("groups missing price diagnostics by asset with missing-date summary", () => {
    renderIssueSheet({
      ...diagnosticIssue,
      title: "3 price dates need review",
      message:
        "Some trading days are missing exact market prices. If a date was a market holiday, dismiss this issue.",
      diagnostics: [
        {
          ...diagnosticMeta,
          fingerprint: "aapl-2026-06-01",
          domain: "marketData",
          code: "MISSING_MARKET_QUOTE",
          title: "No price found",
          explanation:
            "Wealthfolio is missing the exact market price for this holding on the affected date.",
          date: "2026-06-01",
          evidence: [
            {
              label: "Asset",
              value: "AAPL — Apple Inc.",
              route: "/holdings/asset_aapl?tab=quotes&healthContext=price&date=2026-06-01",
            },
            { label: "Date", value: "2026-06-01" },
          ],
          entities: [{ kind: "asset", id: "asset_aapl", label: "AAPL — Apple Inc." }],
          actions: [
            {
              primary: true,
              kind: "fix",
              id: "sync_prices",
              label: "Sync Prices",
              payload: ["asset_aapl"],
            },
          ],
        },
        {
          ...diagnosticMeta,
          fingerprint: "aapl-2026-06-02",
          domain: "marketData",
          code: "MISSING_MARKET_QUOTE",
          title: "No price found",
          explanation:
            "Wealthfolio is missing the exact market price for this holding on the affected date.",
          date: "2026-06-02",
          evidence: [
            {
              label: "Asset",
              value: "AAPL — Apple Inc.",
              route: "/holdings/asset_aapl?tab=quotes&healthContext=price&date=2026-06-02",
            },
            { label: "Date", value: "2026-06-02" },
          ],
          entities: [{ kind: "asset", id: "asset_aapl", label: "AAPL — Apple Inc." }],
          actions: [
            {
              primary: true,
              kind: "fix",
              id: "sync_prices",
              label: "Sync Prices",
              payload: ["asset_aapl"],
            },
          ],
        },
        {
          ...diagnosticMeta,
          fingerprint: "msft-2026-06-02",
          domain: "marketData",
          code: "MISSING_MARKET_QUOTE",
          title: "No price found",
          explanation:
            "Wealthfolio is missing the exact market price for this holding on the affected date.",
          date: "2026-06-02",
          evidence: [
            {
              label: "Asset",
              value: "MSFT — Microsoft Corporation",
              route: "/holdings/asset_msft?tab=quotes&healthContext=price&date=2026-06-02",
            },
            { label: "Date", value: "2026-06-02" },
          ],
          entities: [{ kind: "asset", id: "asset_msft", label: "MSFT — Microsoft Corporation" }],
          actions: [
            {
              primary: true,
              kind: "fix",
              id: "sync_prices",
              label: "Sync Prices",
              payload: ["asset_msft"],
            },
          ],
        },
      ],
    });

    expect(screen.getAllByText("AAPL — Apple Inc.")).toHaveLength(1);
    expect(screen.getByText("MSFT — Microsoft Corporation")).toBeInTheDocument();
    expect(screen.getByText(/2 missing trading days/i)).toBeInTheDocument();
    expect(screen.getByText(/1 missing trading day/i)).toBeInTheDocument();
    expect(screen.getByText("Prices by investment")).toBeInTheDocument();
    expect(screen.getByText(/2 investments/i)).toBeInTheDocument();
    expect(screen.getAllByText(/holidays or non-trading days/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("About this issue")).not.toBeInTheDocument();
    expect(screen.queryByText("No price found")).not.toBeInTheDocument();

    const aaplUrl = new URL(
      screen.getByText("AAPL — Apple Inc.").closest("a")?.getAttribute("href") ?? "",
      "http://localhost",
    );
    expect(aaplUrl.pathname).toBe("/holdings/asset_aapl");
    expect(aaplUrl.searchParams.get("tab")).toBe("quotes");
    expect(aaplUrl.searchParams.get("healthContext")).toBe("price");
    expect(aaplUrl.searchParams.has("date")).toBe(false);
  });

  it("renders mixed diagnostic causes with their own copy", () => {
    render(
      <MemoryRouter>
        <IssueDetailSheet
          issue={{
            ...diagnosticIssue,
            diagnostics: [
              {
                ...diagnosticMeta,
                fingerprint: "basis",
                code: "INCOMPLETE_BASIS_ACTIVITY",
                title: "Missing purchase price",
                explanation: "This buy has no price, so cost cannot be calculated.",
                evidence: [{ label: "Asset", value: "CGX — Cineplex Inc." }],
                actions: [
                  {
                    primary: true,
                    kind: "navigate",
                    route: "/activities",
                    query: { activity: "buy-1", healthContext: "activity" },
                    label: "Review Transaction",
                  },
                  {
                    primary: false,
                    kind: "fix",
                    id: "rebuild_account_history",
                    label: "Rebuild History",
                    payload: ["acc-1"],
                  },
                ],
              },
              {
                ...diagnosticMeta,
                fingerprint: "manual-value",
                domain: "marketData",
                code: "MISSING_MANUAL_VALUATION",
                title: "Missing manual valuation",
                explanation: "This manual holding needs a price before it can be valued.",
                evidence: [{ label: "Holding", value: "ALT — Private Fund" }],
                actions: [
                  {
                    primary: true,
                    kind: "navigate",
                    route: "/holdings/asset_alt",
                    query: { tab: "quotes" },
                    label: "Add Price",
                  },
                ],
              },
            ],
          }}
          open={true}
          onOpenChange={noop}
          onDismiss={noop}
          onFix={noop}
          onRunFixAction={noop}
          isDismissing={false}
          isFixing={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Missing purchase price")).toBeInTheDocument();
    expect(
      screen.getByText("This buy has no price, so cost cannot be calculated."),
    ).toBeInTheDocument();
    expect(screen.getByText("Missing manual valuation")).toBeInTheDocument();
    expect(
      screen.getByText("This manual holding needs a price before it can be valued."),
    ).toBeInTheDocument();
    expect(screen.getByText("ALT — Private Fund")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rebuild History/i })).toBeInTheDocument();
  });
});
