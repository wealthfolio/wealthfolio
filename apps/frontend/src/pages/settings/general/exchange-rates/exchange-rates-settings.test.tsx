import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ExchangeRatesSettings } from "./exchange-rates-settings";

const mocks = vi.hoisted(() => ({ getExchangeRates: vi.fn() }));
vi.mock("@/adapters", () => ({
  getExchangeRates: mocks.getExchangeRates,
  addExchangeRate: vi.fn(),
  updateExchangeRate: vi.fn(),
  deleteExchangeRate: vi.fn(),
  logger: { error: vi.fn() },
}));

const manualRate = (id: string, fromCurrency: string, toCurrency: string, rate: number) => ({
  id,
  fromCurrency,
  toCurrency,
  source: "MANUAL",
  rate,
  timestamp: "2026-11-02T00:00:00Z",
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
