import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Dialog } from "@wealthfolio/ui";
import { Activity } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContributionLimitForm } from "./contribution-limit-form";

const mocks = vi.hoisted(() => ({
  // Swapped for a real save in tests that need one.
  useAddLimit: null as null | (() => unknown),
  updateLimit: vi.fn(),
}));

vi.mock("../use-contribution-limit-mutations", () => ({
  useContributionLimitMutations: () => ({
    addContributionLimitMutation: mocks.useAddLimit?.() ?? {
      mutateAsync: vi.fn(),
      isPending: false,
    },
    updateContributionLimitMutation: { mutateAsync: mocks.updateLimit, isPending: false },
  }),
}));

/** The month segment of each date field, start date first. */
const monthSegments = () =>
  screen
    .getAllByRole("spinbutton")
    .filter((segment) => /month/i.test(segment.getAttribute("aria-label") ?? ""));

describe("ContributionLimitForm on a screen kept out of sight", () => {
  it("keeps a start date set by hand when the screen is shown again", () => {
    const view = (hidden: boolean) => (
      <Activity mode={hidden ? "hidden" : "visible"}>
        {/* The form is the body of the add/edit dialog. */}
        <Dialog open>
          <ContributionLimitForm
            defaultValues={{
              groupName: "TFSA",
              contributionYear: 2026,
              limitAmount: 7000,
            }}
          />
        </Dialog>
      </Activity>
    );
    const { rerender } = render(view(false));
    const [startMonth] = monthSegments();
    expect(startMonth).toHaveAttribute("aria-valuenow", "1");

    // The year's dates fill in; the user moves the start to April.
    act(() => startMonth.focus());
    for (let step = 0; step < 3; step++) fireEvent.keyDown(startMonth, { key: "ArrowUp" });
    expect(monthSegments()[0]).toHaveAttribute("aria-valuenow", "4");

    rerender(view(true));
    rerender(view(false));
    expect(monthSegments()[0]).toHaveAttribute("aria-valuenow", "4");
  });

  it("finishes when its save ends while the screen is out of sight", async () => {
    let finish: () => void = () => undefined;
    const saved = new Promise<void>((resolve) => (finish = resolve));
    mocks.useAddLimit = () => useMutation({ mutationFn: () => saved });
    const client = new QueryClient();
    const onSuccess = vi.fn();
    const view = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <Dialog open>
            <ContributionLimitForm
              defaultValues={{ groupName: "TFSA", contributionYear: 2026, limitAmount: 7000 }}
              onSuccess={onSuccess}
            />
          </Dialog>
        </Activity>
      </QueryClientProvider>
    );
    const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveStatus()).toBe("pending"));

    rerender(view(true));
    act(() => finish());
    await waitFor(() => expect(saveStatus()).toBe("success"));
    rerender(view(false));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    mocks.useAddLimit = null;
  });
});

describe("ContributionLimitForm dates", () => {
  it("saves the year's first and last days as the date picker would", async () => {
    const mutateAsync = vi.fn();
    mocks.useAddLimit = () => ({ mutateAsync, isPending: false });
    render(
      <Dialog open>
        <ContributionLimitForm
          defaultValues={{ groupName: "TFSA", contributionYear: 2026, limitAmount: 7000 }}
        />
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      startDate: new Date(2026, 0, 1).toISOString(),
      endDate: new Date(2026, 11, 31).toISOString(),
    });
    mocks.useAddLimit = null;
  });

  // An April–March tax year, saved as the date picker gives its days.
  const taxYear = {
    id: "limit-1",
    groupName: "ISA",
    contributionYear: 2026,
    limitAmount: 20000,
    startDate: new Date(2026, 3, 1).toISOString(),
    endDate: new Date(2027, 2, 31).toISOString(),
  };

  it("keeps a saved limit's dates when it is opened and updated", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm defaultValues={taxYear} />
      </Dialog>,
    );
    expect(monthSegments().map((segment) => segment.getAttribute("aria-valuenow"))).toEqual([
      "4",
      "3",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    expect(mocks.updateLimit.mock.calls[0][0].updatedLimit).toMatchObject({
      startDate: taxYear.startDate,
      endDate: taxYear.endDate,
    });
  });

  it("moves the dates to a year typed one digit at a time", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm defaultValues={taxYear} />
      </Dialog>,
    );

    const year = screen.getByPlaceholderText("e.g., 2024");
    for (const value of ["", "2", "20", "202", "2027"]) {
      fireEvent.change(year, { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    expect(mocks.updateLimit.mock.calls[0][0].updatedLimit).toMatchObject({
      contributionYear: 2027,
      startDate: new Date(2027, 0, 1).toISOString(),
      endDate: new Date(2027, 11, 31).toISOString(),
    });
  });

  it("initializes a legacy limit without dates from its year", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm
          defaultValues={{ ...taxYear, startDate: undefined, endDate: undefined }}
        />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    expect(mocks.updateLimit.mock.calls[0][0].updatedLimit).toMatchObject({
      startDate: new Date(2026, 0, 1).toISOString(),
      endDate: new Date(2026, 11, 31).toISOString(),
    });
  });

  it("keeps a saved limit's only date instead of filling in its year", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm defaultValues={{ ...taxYear, endDate: null }} />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    const { updatedLimit } = mocks.updateLimit.mock.calls[0][0];
    expect(updatedLimit.startDate).toBe(taxYear.startDate);
    expect(updatedLimit.endDate ?? null).toBeNull();
  });

  it("keeps the dates it opens with until the year is changed", async () => {
    const mutateAsync = vi.fn();
    mocks.useAddLimit = () => ({ mutateAsync, isPending: false });
    // A projected limit for a tax year that doesn't follow the calendar year.
    const startDate = new Date(2027, 3, 6);
    const endDate = new Date(2028, 3, 5);
    render(
      <Dialog open>
        <ContributionLimitForm
          defaultValues={{
            groupName: "ISA",
            contributionYear: 2027,
            limitAmount: 20000,
            startDate,
            endDate,
          }}
        />
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });
    mocks.useAddLimit = null;
  });
});
