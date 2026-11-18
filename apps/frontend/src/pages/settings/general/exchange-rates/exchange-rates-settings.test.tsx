import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ExchangeRatesSettings } from "./exchange-rates-settings";

const mocks = vi.hoisted(() => ({ getExchangeRates: vi.fn(), addExchangeRate: vi.fn() }));
vi.mock("@/adapters", () => ({
  getExchangeRates: mocks.getExchangeRates,
  addExchangeRate: mocks.addExchangeRate,
  updateExchangeRate: vi.fn(),
  deleteExchangeRate: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("@/hooks/use-market-data-providers", () => ({
  useMarketDataProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-custom-providers", () => ({ useCustomProviders: () => ({ data: [] }) }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    worldCurrencies: actual.worldCurrencies.filter((currency) =>
      ["USD", "EUR", "CAD"].includes(currency.value),
    ),
  };
});

const manualRate = (id: string, fromCurrency: string, toCurrency: string, rate: number) => ({
  id,
  fromCurrency,
  toCurrency,
  source: "MANUAL",
  rate,
  timestamp: "2026-11-02T00:00:00Z",
});

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FormattingProvider locale="en-US">
        <MemoryRouter>
          <ExchangeRatesSettings />
        </MemoryRouter>
      </FormattingProvider>
    </QueryClientProvider>,
  );
  return client;
}

it("keeps a manual rate being edited when the rates refetch", async () => {
  mocks.getExchangeRates.mockResolvedValue([manualRate("usd-eur", "USD", "EUR", 1.2345)]);
  const client = renderSettings();

  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Rate" }), { target: { value: "1.5678" } });

  // A portfolio update invalidates queries; the refetch re-renders the page.
  const calls = mocks.getExchangeRates.mock.calls.length;
  await act(() => client.invalidateQueries());
  await waitFor(() => expect(mocks.getExchangeRates.mock.calls.length).toBeGreaterThan(calls));

  expect(screen.getByRole("textbox", { name: "Rate" })).toHaveValue("1.5678");
});

it("drops an open edit and delete when a refetch moves another pair into their row", async () => {
  const usdEur = manualRate("usd-eur", "USD", "EUR", 1.2345);
  mocks.getExchangeRates.mockResolvedValue([usdEur]);
  const client = renderSettings();

  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Rate" }), { target: { value: "1.5678" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Delete exchange rate")).toBeInTheDocument();

  // Rows are keyed by position, so AUD/CAD now takes USD/EUR's row.
  mocks.getExchangeRates.mockResolvedValue([manualRate("aud-cad", "AUD", "CAD", 0.9), usdEur]);
  await act(() => client.invalidateQueries());
  await screen.findByText("AUD");

  expect(screen.queryByRole("textbox", { name: "Rate" })).not.toBeInTheDocument();
  expect(screen.queryByText("Delete exchange rate")).not.toBeInTheDocument();
});

it("retains a failed submission, blocks duplicate pending saves, and closes only after success", async () => {
  mocks.getExchangeRates.mockResolvedValue([]);
  let rejectSave: (reason: Error) => void = () => {};
  const pending = new Promise((_resolve, reject) => {
    rejectSave = reject;
  });
  mocks.addExchangeRate.mockReset();
  mocks.addExchangeRate
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(manualRate("new", "USD", "EUR", 1.25));
  renderSettings();
  const user = userEvent.setup();
  await screen.findByText("No exchange rates defined yet");
  await user.click(screen.getAllByRole("button", { name: "Add rate" })[0]);
  for (const [label, option] of [
    ["From currency", /United States dollar/],
    ["To currency", /Euro/],
  ] as const) {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: option }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
  }
  fireEvent.change(screen.getByRole("textbox", { name: "Exchange rate" }), {
    target: { value: "1.25" },
  });
  const save = screen.getByRole("button", { name: "Add exchange rate" });
  await user.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(screen.getByRole("textbox", { name: "Exchange rate" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.click(save);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Add exchange rate" })).toBeVisible();
  expect(mocks.addExchangeRate).toHaveBeenCalledTimes(1);

  await act(async () => {
    rejectSave(new Error("Rate save failed"));
  });
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getByRole("dialog", { name: "Add exchange rate" })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "From currency" })).toHaveTextContent("USD");
  expect(screen.getByRole("combobox", { name: "To currency" })).toHaveTextContent("EUR");
  expect(screen.getByRole("textbox", { name: "Exchange rate" })).toHaveValue("1.25");

  await user.click(save);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add exchange rate" })).not.toBeInTheDocument(),
  );
  expect(mocks.addExchangeRate).toHaveBeenCalledTimes(2);
});
