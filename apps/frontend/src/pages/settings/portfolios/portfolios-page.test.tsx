import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { Activity } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PortfoliosPage from "./portfolios-page";

const hookMocks = vi.hoisted(() => ({
  useAccounts: vi.fn(),
  usePortfolios: vi.fn(),
  usePortfolioMutations: vi.fn(),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: hookMocks.useAccounts,
}));

vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolios: hookMocks.usePortfolios,
  usePortfolioMutations: hookMocks.usePortfolioMutations,
}));

const updateMutate = vi.fn();
const createMutate = vi.fn();
const deleteMutate = vi.fn();

function account(id: string, name: string, isArchived = false) {
  return {
    id,
    name,
    currency: "USD",
    isArchived,
  };
}

function portfolio(accountIds: string[]) {
  return {
    id: "portfolio-1",
    name: "Retirement",
    description: undefined,
    sortOrder: 0,
    accountIds,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function openEditDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PortfoliosPage />
    </MemoryRouter>,
  );
}

describe("PortfoliosPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.usePortfolioMutations.mockReturnValue({
      createMutation: { mutateAsync: createMutate, isPending: false },
      updateMutation: { mutateAsync: updateMutate, isPending: false },
      deleteMutation: { mutate: deleteMutate, isPending: false },
    });
  });

  it("shows deleted account links in the portfolio list", () => {
    hookMocks.usePortfolios.mockReturnValue({
      data: [portfolio(["account-1", "missing-account"])],
      isLoading: false,
    });
    hookMocks.useAccounts.mockReturnValue({
      accounts: [account("account-1", "Roth IRA")],
    });

    renderPage();

    expect(hookMocks.useAccounts).toHaveBeenCalledWith({
      filterActive: false,
      includeArchived: true,
    });
    expect(screen.getByText("1 account")).toBeInTheDocument();
    expect(screen.getByText("1 deleted link")).toBeInTheDocument();
    expect(screen.getByLabelText("Portfolio has deleted account links")).toBeInTheDocument();
  });

  it("does not treat archived accounts as deleted links", () => {
    hookMocks.usePortfolios.mockReturnValue({
      data: [portfolio(["account-1", "archived-account"])],
      isLoading: false,
    });
    hookMocks.useAccounts.mockReturnValue({
      accounts: [account("account-1", "Roth IRA"), account("archived-account", "Old IRA", true)],
    });

    renderPage();

    expect(screen.getByText("2 accounts")).toBeInTheDocument();
    expect(screen.queryByText(/deleted link/)).not.toBeInTheDocument();
  });

  it("shows missing account warnings and excludes missing ids on save", async () => {
    hookMocks.usePortfolios.mockReturnValue({
      data: [portfolio(["account-1", "missing-account"])],
      isLoading: false,
    });
    hookMocks.useAccounts.mockReturnValue({
      accounts: [account("account-1", "Roth IRA")],
    });

    renderPage();
    await openEditDialog();

    expect(screen.getByText("Saving will remove deleted account links.")).toBeInTheDocument();
    expect(screen.getByText("Deleted account: missing-account")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0]).toMatchObject({
      id: "portfolio-1",
      accountIds: ["account-1"],
    });
  });

  it("keeps save disabled when only deleted account links remain", async () => {
    hookMocks.usePortfolios.mockReturnValue({
      data: [portfolio(["missing-account"])],
      isLoading: false,
    });
    hookMocks.useAccounts.mockReturnValue({
      accounts: [account("account-1", "Roth IRA")],
    });

    renderPage();
    await openEditDialog();

    expect(screen.getByText("Deleted account: missing-account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("closes the new portfolio dialog when its save ends while the screen is out of sight", async () => {
    // On a phone, a screen left for another tab is a hidden <Activity>.
    let finish: () => void = () => undefined;
    const saved = new Promise<void>((resolve) => (finish = resolve));
    hookMocks.usePortfolios.mockReturnValue({ data: [], isLoading: false });
    hookMocks.useAccounts.mockReturnValue({ accounts: [account("account-1", "Roth IRA")] });
    hookMocks.usePortfolioMutations.mockImplementation(() => ({
      createMutation: useMutation({ mutationFn: () => saved }),
      updateMutation: { mutateAsync: updateMutate, isPending: false },
      deleteMutation: { mutate: deleteMutate, isPending: false },
    }));
    const client = new QueryClient();
    const page = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Activity mode={hidden ? "hidden" : "visible"}>
            <PortfoliosPage />
          </Activity>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    // jsdom never ends the closing animation, so a closed dialog stays in the page.
    const dialogOpen = () => screen.queryByRole("dialog")?.hasAttribute("data-open") ?? false;
    const user = userEvent.setup();
    const { rerender } = render(page(false));
    await user.click(screen.getAllByRole("button", { name: "Add portfolio" })[0]);
    await user.type(await screen.findByLabelText("Name"), "Retirement");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveStatus()).toBe("pending"));
    expect(dialogOpen()).toBe(true);

    rerender(page(true));
    act(() => finish());
    await waitFor(() => expect(saveStatus()).toBe("success"));
    rerender(page(false));

    await waitFor(() => expect(dialogOpen()).toBe(false));
  });
});
