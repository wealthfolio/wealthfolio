import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountScopeSelector } from "./account-filter-selector";

const viewport = vi.hoisted(() => ({ mobile: false }));
const inventory = vi.hoisted(() => ({ portfolios: [{ id: "retirement", name: "Retirement" }] }));
vi.mock("@/hooks", () => ({ useIsMobileViewport: () => viewport.mobile }));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: [{ id: "bank", name: "Everyday bank", currency: "USD" }] }),
}));
vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolios: () => ({ data: inventory.portfolios }),
}));

describe("AccountScopeSelector", () => {
  beforeEach(() => {
    viewport.mobile = false;
    inventory.portfolios = [{ id: "retirement", name: "Retirement" }];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
  });
  it("offers all accounts and saved portfolios without individual accounts in portfolio mode", async () => {
    const onChange = vi.fn();
    render(
      <AccountScopeSelector
        value={{ type: "all" }}
        onChange={onChange}
        onManagePortfolios={vi.fn()}
        portfoliosOnly
        triggerVariant="icon"
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Choose portfolio: All Accounts" }));
    expect(screen.getByRole("option", { name: "All Accounts" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Manage portfolios" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Add portfolio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Edit portfolio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Everyday bank/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Retirement" }));
    expect(onChange).toHaveBeenCalledWith({ type: "portfolio", portfolioId: "retirement" });
    expect(screen.queryByRole("option", { name: "Retirement" })).not.toBeInTheDocument();
  });
  it("keeps individual account selection available for existing consumers", async () => {
    render(<AccountScopeSelector value={{ type: "all" }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Everyday bank/ })).toBeVisible();
  });
  it("offers a single Add portfolio action when no saved portfolios exist", async () => {
    inventory.portfolios = [];
    const onManage = vi.fn();
    render(
      <AccountScopeSelector
        value={{ type: "all" }}
        onChange={vi.fn()}
        portfoliosOnly
        triggerVariant="icon"
        onManagePortfolios={onManage}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Choose portfolio: All Accounts" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("option", { name: "Manage portfolios" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Add portfolio" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("uses an accessible mobile sheet and closes it before navigating to management", async () => {
    viewport.mobile = true;
    const onManage = vi.fn();
    render(
      <AccountScopeSelector
        value={{ type: "all" }}
        onChange={vi.fn()}
        portfoliosOnly
        triggerVariant="icon"
        onManagePortfolios={onManage}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Choose portfolio: All Accounts" }));
    const sheet = screen.getByRole("dialog", { name: "Choose portfolio" });
    expect(within(sheet).getByRole("option", { name: "Retirement" })).toBeVisible();
    await userEvent.click(within(sheet).getByRole("option", { name: "Manage portfolios" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
