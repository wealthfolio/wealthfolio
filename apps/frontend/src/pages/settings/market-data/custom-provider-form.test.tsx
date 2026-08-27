import { fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NewCustomProvider } from "@/lib/types/custom-provider";
import { CustomProviderForm } from "./custom-provider-form";

const createProvider = vi.fn();
const updateProvider = vi.fn();
const testSource = vi.fn();

function setInputValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children, ...props }: { children: ReactNode }) => (
    <p {...props}>{children}</p>
  ),
  DialogTitle: ({ children, ...props }: { children: ReactNode }) => <h2 {...props}>{children}</h2>,
}));

vi.mock("@/adapters", () => ({
  openUrlInBrowser: vi.fn(),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCreateCustomProvider: () => ({
    mutate: createProvider,
    isPending: false,
  }),
  useUpdateCustomProvider: () => ({
    mutate: updateProvider,
    isPending: false,
  }),
  useTestCustomProviderSource: () => ({
    mutate: testSource,
    isPending: false,
  }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { timezone: "UTC" },
  }),
}));

describe("CustomProviderForm", () => {
  beforeEach(() => {
    createProvider.mockReset();
    updateProvider.mockReset();
    testSource.mockReset();
  });

  it("keeps latest and historical source values separate while switching tabs", async () => {
    const user = userEvent.setup();

    render(<CustomProviderForm open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /both/i }));

    const urlInput = () => screen.getByLabelText(/url template/i);
    const pricePathInput = () => screen.getByPlaceholderText("$.data.price");

    setInputValue(urlInput(), "https://latest.example.com/price/{SYMBOL}");
    setInputValue(pricePathInput(), "$.price");

    await user.click(screen.getByRole("button", { name: /historical/i }));

    setInputValue(urlInput(), "https://history.example.com/prices/{SYMBOL}");
    setInputValue(pricePathInput(), "$[*].adj_close");

    await user.click(screen.getByRole("button", { name: /latest price/i }));
    expect(urlInput()).toHaveValue("https://latest.example.com/price/{SYMBOL}");
    expect(pricePathInput()).toHaveValue("$.price");

    await user.click(screen.getByRole("button", { name: /historical/i }));
    expect(urlInput()).toHaveValue("https://history.example.com/prices/{SYMBOL}");
    expect(pricePathInput()).toHaveValue("$[*].adj_close");

    const createButton = screen.getByRole("button", { name: /create provider/i });
    fireEvent.submit(createButton.closest("form")!);

    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    const payload = createProvider.mock.calls[0][0] as NewCustomProvider;

    expect(payload.sources).toEqual([
      expect.objectContaining({
        kind: "latest",
        url: "https://latest.example.com/price/{SYMBOL}",
        pricePath: "$.price",
      }),
      expect.objectContaining({
        kind: "historical",
        url: "https://history.example.com/prices/{SYMBOL}",
        pricePath: "$[*].adj_close",
      }),
    ]);
  }, 10_000);

  it("shows body-only identity inputs and passes them to the source tester", async () => {
    const user = userEvent.setup();

    render(<CustomProviderForm open onOpenChange={vi.fn()} />);

    setInputValue(screen.getByLabelText(/url template/i), "https://example.test/quotes");
    await user.selectOptions(screen.getByLabelText(/http method/i), "POST");
    setInputValue(screen.getByLabelText(/request body/i), '{"isin":"{ISIN}","mic":"{MIC}"}');

    setInputValue(screen.getByPlaceholderText("e.g. AAPL"), "AAPL");
    setInputValue(screen.getByPlaceholderText("US0378331005"), "US5949181045");
    setInputValue(screen.getByPlaceholderText("XLON"), "XNAS");
    await user.click(screen.getByRole("button", { name: /^fetch$/i }));

    expect(testSource).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test/quotes",
        body: '{"isin":"{ISIN}","mic":"{MIC}"}',
        symbol: "AAPL",
        isin: "US5949181045",
        mic: "XNAS",
      }),
      expect.any(Object),
    );
  });

  it("resets POST state when applying a quick-start template", async () => {
    const user = userEvent.setup();

    render(<CustomProviderForm open onOpenChange={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText(/http method/i), "POST");
    setInputValue(screen.getByLabelText(/request body/i), '{"symbol":"{SYMBOL}"}');

    await user.click(screen.getByRole("button", { name: /coingecko/i }));

    expect(screen.getByLabelText(/http method/i)).toHaveValue("GET");
    expect(screen.queryByLabelText(/request body/i)).not.toBeInTheDocument();
  });

  it("clears the request body when switching between GET and POST", async () => {
    const user = userEvent.setup();

    render(<CustomProviderForm open onOpenChange={vi.fn()} />);

    const method = screen.getByLabelText(/http method/i);
    await user.selectOptions(method, "POST");
    setInputValue(screen.getByLabelText(/request body/i), '{"symbol":"{SYMBOL}"}');

    await user.selectOptions(method, "GET");
    expect(screen.queryByLabelText(/request body/i)).not.toBeInTheDocument();

    await user.selectOptions(method, "POST");
    expect(screen.getByLabelText(/request body/i)).toHaveValue("");
  });
});
