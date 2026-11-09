import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import type { Account } from "@/lib/types";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { resetLocalTimeZone } from "@internationalized/date";
import { Dialog } from "@wealthfolio/ui";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withProjectedRecurringLimits } from "../contribution-limit-projection";
import { ContributionLimitForm } from "./contribution-limit-form";

const mocks = vi.hoisted(() => ({
  // Swapped for a real save in tests that need one.
  useAddLimit: null as null | (() => unknown),
  updateLimit: vi.fn(),
  // The app's timezone setting; unset, the device's, unless a test sets it.
  timezone: undefined as string | undefined,
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      timezone: mocks.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }),
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
    // Picker-day Date defaults, like those supplied by the add dialog.
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

  describe("when the device and app timezones differ", () => {
    beforeEach(() => resetLocalTimeZone());
    afterEach(() => {
      vi.unstubAllEnvs();
      resetLocalTimeZone();
      mocks.timezone = undefined;
      mocks.useAddLimit = null;
    });

    it("saves the picked days as days in the app's timezone", async () => {
      vi.stubEnv("TZ", "Asia/Tokyo");
      mocks.timezone = "UTC";
      const mutateAsync = vi.fn();
      mocks.useAddLimit = () => ({ mutateAsync, isPending: false });
      render(
        <Dialog open>
          <ContributionLimitForm
            defaultValues={{
              groupName: "ISA",
              contributionYear: 2026,
              limitAmount: 20000,
              // 1 April and 31 March, as the date picker gives them.
              startDate: new Date(2026, 3, 1),
              endDate: new Date(2027, 2, 31),
            }}
          />
        </Dialog>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync.mock.calls[0][0]).toMatchObject({
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: "2027-03-31T00:00:00.000Z",
      });
    });

    it("shows and keeps a saved limit's days in the app's timezone", async () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      mocks.timezone = "Asia/Tokyo";
      mocks.updateLimit.mockClear();
      // Midnight in Tokyo on 1 April 2026 and 31 March 2027.
      const saved = {
        ...taxYear,
        startDate: "2026-03-31T15:00:00.000Z",
        endDate: "2027-03-30T15:00:00.000Z",
      };
      render(
        <Dialog open>
          <ContributionLimitForm defaultValues={saved} />
        </Dialog>,
      );
      const days = screen
        .getAllByRole("spinbutton")
        .filter((segment) => /day/i.test(segment.getAttribute("aria-label") ?? ""));
      expect(
        [...monthSegments(), ...days].map((segment) => segment.getAttribute("aria-valuenow")),
      ).toEqual(["4", "3", "1", "31"]);

      fireEvent.click(screen.getByRole("button", { name: "Update" }));

      await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
      expect(mocks.updateLimit.mock.calls[0][0].updatedLimit).toMatchObject({
        startDate: saved.startDate,
        endDate: saved.endDate,
      });
    });

    it.each([
      ["", "2026-04-01", "2027-03-31", "2026-04-01T00:00:00.000Z", "2027-03-31T00:00:00.000Z"],
      [" \t ", "2026-04-01", "2027-03-31", "2026-04-01T00:00:00.000Z", "2027-03-31T00:00:00.000Z"],
      [
        "America/Los_Angeles",
        "2026-03-08",
        "2026-11-01",
        "2026-03-08T08:00:00.000Z",
        "2026-11-01T07:00:00.000Z",
      ],
      [
        "Asia/Beirut",
        "2026-03-29",
        "2026-03-29",
        "2026-03-28T22:00:00.000Z",
        "2026-03-28T22:00:00.000Z",
      ],
      [
        "America/Santiago",
        "2026-09-06",
        "2026-09-06",
        "2026-09-06T04:00:00.000Z",
        "2026-09-06T04:00:00.000Z",
      ],
    ])(
      "saves the counted days in app timezone %j",
      async (timezone, startDay, endDay, startDate, endDate) => {
        vi.stubEnv("TZ", "Asia/Tokyo");
        mocks.timezone = timezone;
        const mutateAsync = vi.fn();
        mocks.useAddLimit = () => ({ mutateAsync, isPending: false });
        render(
          <Dialog open>
            <ContributionLimitForm
              defaultValues={{
                groupName: "ISA",
                contributionYear: 2026,
                limitAmount: 20000,
                startDate: new Date(`${startDay}T00:00:00`),
                endDate: new Date(`${endDay}T00:00:00`),
              }}
            />
          </Dialog>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
        expect(mutateAsync.mock.calls[0][0]).toMatchObject({ startDate, endDate });
        const dayInApp = (date: string) =>
          new Intl.DateTimeFormat("en-CA", { timeZone: timezone.trim() || "UTC" }).format(
            new Date(date),
          );
        expect(dayInApp(mutateAsync.mock.calls[0][0].startDate)).toBe(startDay);
        expect(dayInApp(mutateAsync.mock.calls[0][0].endDate)).toBe(endDay);
      },
    );

    it("keeps projected instant strings when adding a recurring limit", async () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      mocks.timezone = "Asia/Tokyo";
      const projected = withProjectedRecurringLimits(
        [
          {
            ...taxYear,
            isRecurring: true,
            startDate: "2026-03-31T15:00:00.000Z",
            endDate: "2027-03-30T15:00:00.000Z",
          },
        ],
        2027,
        0,
        mocks.timezone,
      ).find((limit) => limit.isProjected)!;
      const mutateAsync = vi.fn();
      mocks.useAddLimit = () => ({ mutateAsync, isPending: false });
      render(
        <Dialog open>
          <ContributionLimitForm defaultValues={{ ...projected, id: "" }} />
        </Dialog>,
      );
      expect(monthSegments().map((segment) => segment.getAttribute("aria-valuenow"))).toEqual([
        "4",
        "3",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
      expect(mutateAsync.mock.calls[0][0]).toMatchObject({
        contributionYear: 2027,
        startDate: "2027-03-31T15:00:00.000Z",
        endDate: "2028-03-30T15:00:00.000Z",
      });
    });

    it("opens the former noon-UTC defaults as their year's first and last days", async () => {
      vi.stubEnv("TZ", "Europe/London");
      mocks.timezone = "Pacific/Kiritimati";
      mocks.updateLimit.mockClear();
      render(
        <Dialog open>
          <ContributionLimitForm
            defaultValues={{
              ...taxYear,
              startDate: "2026-01-01T12:00:00.000Z",
              endDate: "2026-12-31T12:00:00.000Z",
            }}
          />
        </Dialog>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Update" }));

      await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
      // Midnight in Kiritimati (UTC+14) on 1 January and 31 December.
      expect(mocks.updateLimit.mock.calls[0][0].updatedLimit).toMatchObject({
        startDate: "2025-12-31T10:00:00.000Z",
        endDate: "2026-12-30T10:00:00.000Z",
      });
    });
  });
});

describe("ContributionLimitForm amount", () => {
  it("keeps a limit amount with more than two decimals", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm
          defaultValues={{
            id: "limit-1",
            groupName: "BTC stack",
            contributionYear: 2026,
            limitAmount: 0.0015,
          }}
        />
      </Dialog>,
    );
    expect(screen.getByRole("textbox", { name: "Limit amount" })).toHaveValue("0.0015");

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    expect(mocks.updateLimit.mock.calls[0][0].updatedLimit.limitAmount).toBe(0.0015);
  });
});

describe("ContributionLimitForm accounts", () => {
  const accounts = [
    { id: "ira", name: "Roth IRA", accountType: "SECURITIES", isActive: true },
    { id: "card", name: "Visa", accountType: "CREDIT_CARD", isActive: true },
    { id: "old", name: "Old IRA", accountType: "SECURITIES", isActive: false },
  ] as Account[];

  it("lists accounts that can hold contributions and saves the ticked ones", async () => {
    mocks.updateLimit.mockClear();
    render(
      <Dialog open>
        <ContributionLimitForm
          // "gone" is an account the list no longer shows; it stays selected.
          defaultValues={{
            id: "limit-1",
            groupName: "IRA 2026",
            contributionYear: 2026,
            limitAmount: 7000,
            accountIds: "gone,ira",
          }}
          accounts={accounts}
        />
      </Dialog>,
    );

    const group = screen.getByRole("group", { name: "Accounts that count" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(group).toHaveTextContent("Roth IRA");
    expect(group).toHaveTextContent("Old IRAHidden");
    expect(group).not.toHaveTextContent("Visa");
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    fireEvent.click(within(group).getByText("Roth IRA"));
    fireEvent.click(within(group).getByText("Old IRA"));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledTimes(1));
    expect(mocks.updateLimit.mock.calls[0][0].updatedLimit.accountIds).toBe("gone,old");
  });

  it("lists ticked accounts first, counts them, and filters a long list by name", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: `acc-${index}`,
      name: `Account ${String.fromCharCode(65 + index)}`,
      accountType: "SECURITIES",
      isActive: true,
    })) as Account[];
    render(
      <Dialog open>
        <ContributionLimitForm
          defaultValues={{
            id: "limit-1",
            groupName: "IRA 2026",
            contributionYear: 2026,
            limitAmount: 7000,
            accountIds: "acc-7",
          }}
          accounts={many}
        />
      </Dialog>,
    );

    const group = screen.getByRole("group", { name: "Accounts that count" });
    expect(within(group).getAllByRole("checkbox")[0]).toHaveAccessibleName("Account H");
    expect(screen.getByText("1 of 10 selected")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search accounts" }), {
      target: { value: "account c" },
    });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(group).getByText("Account C")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search accounts" }), {
      target: { value: "zzz" },
    });
    expect(within(group).getByText("No accounts match your search.")).toBeInTheDocument();

    // Enter in the search field filters; it doesn't save the limit.
    mocks.updateLimit.mockClear();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search accounts" }), "{Enter}");
    await Promise.resolve();
    expect(mocks.updateLimit).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox", { name: "Search accounts" })).toBeInTheDocument();
  });
});
