import { act, render, renderHook, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContributionLimit } from "@/lib/types";
import { AccountContributionLimit } from "./account-contribution-limit";
import { useContributionLimitMutations } from "@/pages/settings/contribution-limits/use-contribution-limit-mutations";

const mocks = vi.hoisted(() => ({
  limits: [] as ContributionLimit[],
  timezone: "Europe/London",
  deposits: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getContributionLimit: () => Promise.resolve(mocks.limits),
  calculateDepositsForLimit: mocks.deposits,
  createContributionLimit: vi.fn(),
  deleteContributionLimit: vi.fn(),
  updateContributionLimit: () => Promise.resolve(mocks.limits[0]),
  logger: { error: vi.fn() },
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: mocks.timezone } }),
}));

const isaLimit = (groupName: string, year: number): ContributionLimit => ({
  id: groupName,
  groupName,
  contributionYear: year,
  limitAmount: 20000,
  accountIds: "isa",
  // 1 April to 31 March, at London midnight as the date picker saves them.
  startDate: `${year}-03-31T23:00:00.000Z`,
  endDate: `${year + 1}-03-30T23:00:00.000Z`,
});

function renderOn(today: string) {
  vi.useFakeTimers({ now: new Date(today), toFake: ["Date"] });
  mocks.deposits.mockResolvedValue({ total: 5000, baseCurrency: "GBP", byAccount: {} });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000 } } });
  render(
    <QueryClientProvider client={client}>
      <AccountContributionLimit accountId="isa" />
    </QueryClientProvider>,
  );
  return client;
}

describe("AccountContributionLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    mocks.timezone = "Europe/London";
    mocks.deposits.mockReset();
  });

  it("shows an April–March limit from January to March of its second year", async () => {
    mocks.limits = [isaLimit("ISA 2026/27", 2026)];
    renderOn("2027-02-15T12:00:00Z");
    expect(await screen.findByText(/ISA 2026\/27/)).toBeInTheDocument();
  });

  it("shows the limit running today, not a later one with today's year", async () => {
    mocks.limits = [isaLimit("ISA 2027/28", 2027), isaLimit("ISA 2026/27", 2026)];
    renderOn("2027-02-15T12:00:00Z");
    expect(await screen.findByText(/ISA 2026\/27/)).toBeInTheDocument();
    expect(screen.queryByText(/ISA 2027\/28/)).not.toBeInTheDocument();
  });

  it("refreshes the deposit count when a running limit is edited", async () => {
    mocks.limits = [isaLimit("ISA 2026/27", 2026)];
    const client = renderOn("2027-02-15T12:00:00Z");
    await screen.findByText(/ISA 2026\/27/);
    const { result } = renderHook(() => useContributionLimitMutations(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    mocks.deposits.mockResolvedValue({ total: 7000, baseCurrency: "GBP", byAccount: {} });
    await act(async () => {
      await result.current.updateContributionLimitMutation.mutateAsync({
        id: mocks.limits[0].id,
        updatedLimit: { ...mocks.limits[0], startDate: "2026-03-01T00:00:00Z" },
      });
    });

    await waitFor(() => expect(mocks.deposits).toHaveBeenCalledTimes(2));
  });

  it.each([
    {
      boundary: "saved end day",
      today: "2027-03-31T00:00:00Z",
      dates: {},
    },
    {
      boundary: "today's day",
      today: "2027-03-31T23:00:00Z",
      dates: { startDate: "2027-04-01T00:00:00Z", endDate: "2028-03-31T00:00:00Z" },
    },
  ])("uses UTC for $boundary when the timezone setting is blank", async ({ today, dates }) => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    mocks.timezone = " ";
    mocks.limits = [{ ...isaLimit("ISA 2026/27", 2026), ...dates }];
    const client = renderOn(today);

    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByText(/ISA 2026\/27/)).not.toBeInTheDocument();
    expect(mocks.deposits).not.toHaveBeenCalled();
  });
});
