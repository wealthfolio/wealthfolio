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

it("keeps a manual rate being edited when the rates refetch", async () => {
  mocks.getExchangeRates.mockResolvedValue([
    {
      id: "usd-eur",
      fromCurrency: "USD",
      toCurrency: "EUR",
      source: "MANUAL",
      rate: 1.2345,
      timestamp: "2026-11-02T00:00:00Z",
    },
  ]);
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

  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Rate" }), { target: { value: "1.5678" } });

  // A portfolio update invalidates queries; the refetch re-renders the page.
  const calls = mocks.getExchangeRates.mock.calls.length;
  await act(() => client.invalidateQueries());
  await waitFor(() => expect(mocks.getExchangeRates.mock.calls.length).toBeGreaterThan(calls));

  expect(screen.getByRole("textbox", { name: "Rate" })).toHaveValue("1.5678");
});
