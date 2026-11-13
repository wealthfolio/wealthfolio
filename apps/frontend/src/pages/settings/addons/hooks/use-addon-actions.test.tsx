import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedAddon } from "@/adapters";
import { useAddonActions } from "./use-addon-actions";

const mocks = vi.hoisted(() => ({
  installAddon: vi.fn(),
  extractAddon: vi.fn(),
  clearAddonStaging: vi.fn(),
  getInstalledAddons: vi.fn(),
  reloadAllAddons: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  installAddon: mocks.installAddon,
  getInstalledAddons: mocks.getInstalledAddons,
  toggleAddon: vi.fn(),
  uninstallAddon: vi.fn(),
  extractAddon: mocks.extractAddon,
  clearAddonStaging: mocks.clearAddonStaging,
  updateAddonNetworkApprovals: vi.fn(),
}));

vi.mock("@/addons/addons-core", () => ({
  reloadAllAddons: mocks.reloadAllAddons,
}));

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const extractedAddon = {
  metadata: { id: "newer-addon", name: "Newer Add-on", version: "1.0.0", permissions: [] },
  files: [],
} as unknown as ExtractedAddon;

const refusal = new Error("This add-on needs a newer version of Wealthfolio.");

describe("useAddonActions approval failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getInstalledAddons.mockResolvedValue([]);
    mocks.clearAddonStaging.mockResolvedValue(undefined);
  });

  it("shows the refusal when installing a zip fails after approval", async () => {
    mocks.extractAddon.mockResolvedValue(extractedAddon);
    mocks.installAddon.mockRejectedValue(refusal);
    const { result } = renderHook(() => useAddonActions(), { wrapper: createWrapper() });

    await act(() => result.current.handleInstallZipAddon("addon.zip", new Uint8Array([1])));
    const onApprove = result.current.permissionDialog.onApprove;
    expect(onApprove).toBeDefined();
    await act(async () => {
      await expect(onApprove?.([])).resolves.toBeUndefined();
    });

    expect(result.current.permissionDialog.open).toBe(false);
    expect(mocks.reloadAllAddons).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: refusal.message, variant: "destructive" }),
    );
  });

  it("shows the refusal when a store install fails after approval", async () => {
    const { result } = renderHook(() => useAddonActions(), { wrapper: createWrapper() });

    act(() =>
      result.current.handleShowPermissionDialog(extractedAddon, () => Promise.reject(refusal)),
    );
    const onApprove = result.current.permissionDialog.onApprove;
    await act(async () => {
      await expect(onApprove?.([])).resolves.toBeUndefined();
    });

    expect(mocks.clearAddonStaging).toHaveBeenCalledWith("newer-addon");
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: refusal.message, variant: "destructive" }),
    );
  });
});
