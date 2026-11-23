import { render as renderWithFormatting, screen, type RenderOptions } from "@/test/render";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Account, ContributionLimit } from "@/lib/types";
import userEvent from "@testing-library/user-event";
import { ContributionLimitItem } from "./contribution-limit-item";

const render = (ui: ReactElement, options?: RenderOptions) =>
  renderWithFormatting(<MemoryRouter>{ui}</MemoryRouter>, options);

vi.mock("../use-contribution-limit-mutations", () => ({
  useContributionLimitProgress: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./contribution-limit-operations", () => ({ ContributionLimitOperations: () => null }));

describe("ContributionLimitItem", () => {
  it.each([
    ["Asia/Kolkata", "2026-03-31T18:30:00.000Z", "2027-03-30T18:30:00.000Z"],
    ["America/New_York", "2026-04-01T04:00:00.000Z", "2027-03-31T04:00:00.000Z"],
    ["UTC", "2026-04-01T00:00:00.000Z", "2027-03-31T00:00:00.000Z"],
  ])("shows the dates picked in %s", (timezone, startDate, endDate) => {
    const inAppTimezone = ({ children }: { children: ReactNode }) => (
      <FormattingProvider locale="en-US" timezone={timezone}>
        {children}
      </FormattingProvider>
    );
    render(
      <ContributionLimitItem
        // 1 April 2026 to 31 March 2027: local midnights.
        limit={{
          id: "limit1",
          groupName: "PPF",
          contributionYear: 2026,
          limitAmount: 150000,
          accountIds: "acc1",
          startDate,
          endDate,
          createdAt: "2026-03-31T18:30:00.000Z",
          updatedAt: "2026-03-31T18:30:00.000Z",
        }}
        accounts={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
      { wrapper: inAppTimezone },
    );

    expect(screen.getByText("Apr 1 → Mar 31, 2027")).toBeInTheDocument();
    expect(screen.getByText("Apr 1, 2026 → Mar 31, 2027")).toBeInTheDocument();
  });

  it.each(["Pacific/Auckland", "Pacific/Kiritimati"])(
    "shows the former noon-UTC default dates as saved in %s",
    (timezone) => {
      const inAppTimezone = ({ children }: { children: ReactNode }) => (
        <FormattingProvider locale="en-US" timezone={timezone}>
          {children}
        </FormattingProvider>
      );
      render(
        <ContributionLimitItem
          limit={{
            id: "limit1",
            groupName: "TFSA",
            contributionYear: 2026,
            limitAmount: 7000,
            accountIds: "acc1",
            startDate: "2026-01-01T12:00:00.000Z",
            endDate: "2026-12-31T12:00:00.000Z",
          }}
          accounts={[]}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
        { wrapper: inAppTimezone },
      );

      expect(screen.getByText("Jan 1 → Dec 31, 2026")).toBeInTheDocument();
      expect(screen.getByText("Jan 1, 2026 → Dec 31, 2026")).toBeInTheDocument();
    },
  );

  it("formats a noon-UTC pair outside the contribution year in the app's time zone", () => {
    const inKiritimati = ({ children }: { children: ReactNode }) => (
      <FormattingProvider locale="en-US" timezone="Pacific/Kiritimati">
        {children}
      </FormattingProvider>
    );
    render(
      <ContributionLimitItem
        limit={{
          id: "limit1",
          groupName: "TFSA",
          contributionYear: 2026,
          limitAmount: 7000,
          accountIds: "acc1",
          startDate: "2027-01-01T12:00:00.000Z",
          endDate: "2027-12-31T12:00:00.000Z",
        }}
        accounts={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
      { wrapper: inKiritimati },
    );

    expect(screen.getByText("Jan 2 → Jan 1, 2028")).toBeInTheDocument();
    expect(screen.getByText("Jan 2, 2027 → Jan 1, 2028")).toBeInTheDocument();
  });

  describe("accounts", () => {
    const account = (id: string, name: string) =>
      ({ id, name, accountType: "SECURITIES", isActive: true }) as Account;
    const accounts = ["a", "b", "c", "d", "e"].map((id) => account(id, `Account ${id}`));
    const limit = (accountIds: string): ContributionLimit => ({
      id: "limit 1",
      groupName: "IRA 2026",
      contributionYear: 2026,
      limitAmount: 7000,
      accountIds,
    });

    it("names up to three accounts and counts the rest", () => {
      render(
        <ContributionLimitItem
          limit={limit("a,b,c,d,e")}
          accounts={accounts}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      const list = screen.getByRole("list", { name: "Accounts that count" });
      expect(list).toHaveTextContent("Account aAccount bAccount c+2 more");
    });

    it("links its title to the limit's details", () => {
      render(
        <ContributionLimitItem
          limit={limit("a")}
          accounts={accounts}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      for (const link of screen.getAllByRole("link", { name: "IRA 2026", hidden: true })) {
        expect(link).toHaveAttribute("href", "/settings/contribution-limits/limit%201");
      }
      expect(screen.queryByRole("button", { name: "IRA 2026" })).not.toBeInTheDocument();
    });

    it("opens the edit dialog to choose accounts when none are selected", async () => {
      const onEdit = vi.fn();
      render(
        <ContributionLimitItem
          limit={limit("")}
          accounts={accounts}
          onEdit={onEdit}
          onDelete={vi.fn()}
        />,
      );
      expect(screen.getByText("No accounts selected")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Choose accounts" }));
      expect(onEdit).toHaveBeenCalledWith(limit(""));
    });
  });
});
