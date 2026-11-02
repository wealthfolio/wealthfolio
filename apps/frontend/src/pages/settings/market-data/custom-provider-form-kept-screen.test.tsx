import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "react";
import { expect, it, vi } from "vitest";
import { CustomProviderForm } from "./custom-provider-form";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/adapters", () => ({
  createCustomProvider: mocks.create,
  updateCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
  getCustomProviders: vi.fn(),
  testCustomProviderSource: vi.fn(),
  openUrlInBrowser: vi.fn(),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));

it("closes a new provider once its save ends while the screen is out of sight", async () => {
  // On a phone, a screen kept under another one is a hidden <Activity>; a form
  // left open there would create the provider again.
  let finish: () => void = () => undefined;
  mocks.create.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const onOpenChange = vi.fn();
  const client = new QueryClient();
  const view = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <Activity mode={hidden ? "hidden" : "visible"}>
        <CustomProviderForm open onOpenChange={onOpenChange} />
      </Activity>
    </QueryClientProvider>
  );
  const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(view(false));
  fireEvent.change(screen.getByLabelText(/url template/i), {
    target: { value: "https://funds.example.com/nav/{ISIN}" },
  });
  fireEvent.change(screen.getByPlaceholderText("$.data.price"), { target: { value: "$.price" } });
  fireEvent.submit(screen.getByRole("button", { name: /create provider/i }).closest("form")!);
  await waitFor(() => expect(saveStatus()).toBe("pending"));

  rerender(view(true));
  act(() => finish());
  await waitFor(() => expect(saveStatus()).toBe("success"));
  rerender(view(false));

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});
