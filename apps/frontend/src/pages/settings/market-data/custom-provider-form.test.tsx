import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomProviderForm } from "./custom-provider-form";
import type { NewCustomProvider } from "@/lib/types/custom-provider";

const createProvider = vi.fn();
const updateProvider = vi.fn();

function setInputValue(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

vi.mock("@wealthfolio/ui", () => ({
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
    mutate: vi.fn(),
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
});
