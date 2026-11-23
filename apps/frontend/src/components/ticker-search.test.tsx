import { render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { SheetNavigation } from "@wealthfolio/ui";
import { expect, it, vi } from "vitest";

import TickerSearchInput from "./ticker-search";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  searchTicker: vi.fn().mockResolvedValue([]),
}));

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

it("opens as a screen of a phone form's sheet with its search field focused", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SheetNavigation>
        <TickerSearchInput aria-label="Symbol" onSelectResult={vi.fn()} />
      </SheetNavigation>
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole("combobox", { name: "Symbol" });

  await user.click(trigger);

  const pickerScreen = screen.getByRole("dialog", { name: "Select Symbol" });
  expect(pickerScreen).toContainElement(document.activeElement as HTMLElement);
  expect(document.activeElement).toHaveAttribute("placeholder", "Search for symbol");

  // Escape goes back to the form.
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Select Symbol" })).not.toBeInTheDocument();
});
