import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuoteImport } from "@/lib/types/quote-import";

import MarketDataImportPage from "./market-data-import-page";

const adapterMocks = vi.hoisted(() => ({
  checkQuotesImport: vi.fn(),
  importManualQuotes: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);

const quote: QuoteImport = {
  symbol: "AAPL",
  date: "2026-01-02",
  close: 100,
  currency: "USD",
  validationStatus: "valid",
};

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MarketDataImportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const validateFile = async (container: HTMLElement) => {
  const fileInput = await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    return input!;
  });
  fireEvent.change(fileInput, {
    target: { files: [new File(["symbol,date,close\n"], "quotes.csv", { type: "text/csv" })] },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Validate file/ }));
};

const startOverButton = () => screen.getByRole("button", { name: /Start over/ });

// findByRole keeps rerunning its role query while the upload step's real
// 0.3-second Motion exit changes the DOM, so on shared CI runners the wait can
// exceed 1s.
const findImportButton = () =>
  screen.findByRole("button", { name: /Import 1 Quote/ }, { timeout: 5_000 });

// Those waits can push a whole test past the default 5s.
describe("MarketDataImportPage", { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables Start over until validation finishes", async () => {
    let finishValidation!: (quotes: QuoteImport[]) => void;
    adapterMocks.checkQuotesImport.mockReturnValue(
      new Promise<QuoteImport[]>((resolve) => (finishValidation = resolve)),
    );
    const { container } = renderPage();

    await validateFile(container);
    await waitFor(() => expect(adapterMocks.checkQuotesImport).toHaveBeenCalledTimes(1));

    expect(startOverButton()).toBeDisabled();

    finishValidation([quote]);

    expect(await findImportButton()).toBeEnabled();
    expect(startOverButton()).toBeEnabled();
  });

  it("ignores a CSV dropped while a file is validating", async () => {
    let failValidation!: (reason: unknown) => void;
    adapterMocks.checkQuotesImport.mockReturnValue(
      new Promise<QuoteImport[]>((_, reject) => (failValidation = reject)),
    );
    const { container } = renderPage();

    await validateFile(container);
    fireEvent.drop(await screen.findByText("Processing file..."), {
      dataTransfer: {
        files: [new File(["symbol,date,close\n"], "other.csv", { type: "text/csv" })],
      },
    });

    failValidation("Invalid CSV");

    // The error belongs to the file that was validated, not the dropped one.
    expect(await screen.findByText("quotes.csv")).toBeInTheDocument();
    expect(screen.queryByText("other.csv")).not.toBeInTheDocument();
  });

  it("disables Start over and Back until the import finishes", async () => {
    let finishImport!: (quotes: QuoteImport[]) => void;
    adapterMocks.checkQuotesImport.mockResolvedValue([quote]);
    adapterMocks.importManualQuotes.mockReturnValue(
      new Promise<QuoteImport[]>((resolve) => (finishImport = resolve)),
    );
    const { container } = renderPage();

    await validateFile(container);
    const importButton = await findImportButton();
    fireEvent.click(importButton);
    await waitFor(() => expect(adapterMocks.importManualQuotes).toHaveBeenCalledTimes(1));

    expect(startOverButton()).toBeDisabled();
    // The preview's Back button; the mobile header has its own Back that leaves the page.
    expect(
      within(importButton.parentElement!).getByRole("button", { name: /^Back$/ }),
    ).toBeDisabled();

    finishImport([quote]);

    expect(await screen.findByText("Import completed")).toBeInTheDocument();
    expect(startOverButton()).toBeEnabled();
  });

  it("locks the upload form while it animates out to the preview", async () => {
    let finishValidation!: (quotes: QuoteImport[]) => void;
    adapterMocks.checkQuotesImport.mockReturnValueOnce(
      new Promise<QuoteImport[]>((resolve) => (finishValidation = resolve)),
    );
    const { container } = renderPage();

    await validateFile(container);
    const validateButton = screen.getByRole("button", { name: /Validating/ });
    await act(async () => finishValidation([quote]));

    // The outgoing form is still mounted until its exit animation ends.
    expect(validateButton).toBeInTheDocument();
    expect(validateButton).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Remove file/ })).not.toBeInTheDocument();
    fireEvent.click(validateButton);
    fireEvent.click(validateButton);
    expect(adapterMocks.checkQuotesImport).toHaveBeenCalledTimes(1);

    expect(await findImportButton()).toBeEnabled();
  });

  it.each([
    ["Back", "click"],
    ["Back", "Enter"],
    ["Back", "Space"],
    ["Start over", "click"],
    ["Start over", "Enter"],
    ["Start over", "Space"],
  ])("locks the exiting preview after %s against %s activation", async (action, activation) => {
    const user = userEvent.setup();
    adapterMocks.checkQuotesImport.mockResolvedValue([quote]);
    const { container } = renderPage();
    await validateFile(container);
    const importButton = await findImportButton();
    const backButton = within(importButton.parentElement!).getByRole("button", { name: /^Back$/ });
    importButton.focus();

    fireEvent.click(action === "Back" ? backButton : startOverButton());

    // Real Motion retains the outgoing preview for its 0.3-second exit.
    expect(importButton).toBeInTheDocument();
    expect(importButton).toBeDisabled();
    expect(backButton).toBeDisabled();
    expect(importButton.closest("[inert]")).not.toBeNull();
    if (activation === "click") {
      fireEvent.click(importButton);
    } else {
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }

    const nextFileInput = await waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      return input!;
    });
    fireEvent.change(nextFileInput, {
      target: { files: [new File(["symbol,date,close\n"], "second.csv", { type: "text/csv" })] },
    });
    expect(adapterMocks.importManualQuotes).not.toHaveBeenCalled();
    expect(
      screen.queryByText("No quotes to import. Please validate the file first."),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Validate file/ }));
    const nextImportButton = await findImportButton();
    expect(nextImportButton).toBeEnabled();
    fireEvent.click(nextImportButton);
    expect(await screen.findByText("Import completed")).toBeInTheDocument();
    expect(adapterMocks.importManualQuotes).toHaveBeenCalledExactlyOnceWith([
      { ...quote, errorMessage: undefined },
    ]);
  });
});
