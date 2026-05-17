import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomProviderWithSources,
  NewCustomProvider,
  UpdateCustomProvider,
} from "@/lib/types/custom-provider";

import { CustomProviderForm } from "./custom-provider-form";

interface MutateOptions {
  onSuccess?: () => void;
}

interface UpdateProviderArgs {
  providerId: string;
  payload: UpdateCustomProvider;
}

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn<(payload: NewCustomProvider, options?: MutateOptions) => void>(),
  updateProvider: vi.fn<(payload: UpdateProviderArgs, options?: MutateOptions) => void>(),
  testSource: vi.fn<(payload: unknown, options?: MutateOptions) => void>(),
}));

vi.mock("@wealthfolio/ui", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCreateCustomProvider: () => ({ mutate: mocks.createProvider, isPending: false }),
  useUpdateCustomProvider: () => ({ mutate: mocks.updateProvider, isPending: false }),
  useTestCustomProviderSource: () => ({ mutate: mocks.testSource, isPending: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));

function buttonByText(text: string | RegExp): HTMLButtonElement {
  const button = screen.getByText(text).closest("button")!;
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button;
}

describe("CustomProviderForm", () => {
  beforeEach(() => {
    mocks.createProvider.mockReset();
    mocks.updateProvider.mockReset();
    mocks.testSource.mockReset();
  });

  it("keeps latest and historical source configuration separate in both mode", async () => {
    render(<CustomProviderForm open onOpenChange={vi.fn()} />);

    fireEvent.click(buttonByText("Both"));

    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}"), {
      target: { value: "https://latest.example/quote/AAPL" },
    });
    fireEvent.change(screen.getByPlaceholderText("$.data.price"), {
      target: { value: "$.price" },
    });

    fireEvent.click(buttonByText("Historical"));

    expect(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}")).toHaveValue(
      "",
    );
    expect(screen.getByPlaceholderText("$.data.price")).toHaveValue("");

    fireEvent.change(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}"), {
      target: { value: "https://history.example/prices/AAPL" },
    });
    fireEvent.change(screen.getByPlaceholderText("$.data.price"), {
      target: { value: "$[*].adj_close" },
    });

    fireEvent.click(buttonByText("Latest price"));

    expect(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}")).toHaveValue(
      "https://latest.example/quote/AAPL",
    );
    expect(screen.getByPlaceholderText("$.data.price")).toHaveValue("$.price");

    fireEvent.change(screen.getByPlaceholderText("e.g. My Provider"), {
      target: { value: "Custom Prices" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-provider"), {
      target: { value: "custom-prices" },
    });

    fireEvent.click(buttonByText("Create provider"));

    await waitFor(() => expect(mocks.createProvider).toHaveBeenCalledTimes(1));
    const [createArg, createOptions] = mocks.createProvider.mock.calls[0];
    expect(createOptions).toBeDefined();
    expect(createArg.code).toBe("custom-prices");
    expect(createArg.name).toBe("Custom Prices");
    expect(createArg.sources.map(({ kind, url, pricePath }) => ({ kind, url, pricePath }))).toEqual(
      [
        {
          kind: "latest",
          url: "https://latest.example/quote/AAPL",
          pricePath: "$.price",
        },
        {
          kind: "historical",
          url: "https://history.example/prices/AAPL",
          pricePath: "$[*].adj_close",
        },
      ],
    );
  });

  it("keeps existing latest and historical sources separate while editing", async () => {
    const provider: CustomProviderWithSources = {
      id: "custom-prices",
      name: "Custom Prices",
      description: "",
      enabled: true,
      priority: 50,
      sources: [
        {
          id: "latest-source",
          providerId: "custom-prices",
          kind: "latest",
          format: "json",
          url: "https://latest.example/quote/{SYMBOL}",
          pricePath: "$.price",
        },
        {
          id: "historical-source",
          providerId: "custom-prices",
          kind: "historical",
          format: "json",
          url: "https://history.example/prices/{SYMBOL}",
          pricePath: "$[*].close",
        },
      ],
    };

    render(<CustomProviderForm open onOpenChange={vi.fn()} provider={provider} />);

    expect(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}")).toHaveValue(
      "https://latest.example/quote/{SYMBOL}",
    );
    expect(screen.getByPlaceholderText("$.data.price")).toHaveValue("$.price");

    fireEvent.click(buttonByText("Historical"));

    expect(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}")).toHaveValue(
      "https://history.example/prices/{SYMBOL}",
    );
    expect(screen.getByPlaceholderText("$.data.price")).toHaveValue("$[*].close");

    fireEvent.change(screen.getByPlaceholderText("$.data.price"), {
      target: { value: "$[*].adj_close" },
    });

    fireEvent.click(buttonByText("Latest price"));

    expect(screen.getByPlaceholderText("https://api.example.com/v1/price/{SYMBOL}")).toHaveValue(
      "https://latest.example/quote/{SYMBOL}",
    );
    expect(screen.getByPlaceholderText("$.data.price")).toHaveValue("$.price");

    fireEvent.click(buttonByText("Save changes"));

    await waitFor(() => expect(mocks.updateProvider).toHaveBeenCalledTimes(1));
    const [updateArg, updateOptions] = mocks.updateProvider.mock.calls[0];
    expect(updateOptions).toBeDefined();
    expect(updateArg.providerId).toBe("custom-prices");
    expect(updateArg.payload.name).toBe("Custom Prices");
    expect(
      updateArg.payload.sources?.map(({ kind, url, pricePath }) => ({ kind, url, pricePath })),
    ).toEqual([
      {
        kind: "latest",
        url: "https://latest.example/quote/{SYMBOL}",
        pricePath: "$.price",
      },
      {
        kind: "historical",
        url: "https://history.example/prices/{SYMBOL}",
        pricePath: "$[*].adj_close",
      },
    ]);
  });
});
