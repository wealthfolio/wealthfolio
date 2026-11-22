import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedAddon } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useAddonActions } from "./use-addon-actions";

const mocks = vi.hoisted(() => ({
  installAddon: vi.fn(),
  extractAddon: vi.fn(),
  clearAddonStaging: vi.fn(),
  getInstalledAddons: vi.fn(),
  uninstallAddon: vi.fn(),
  reloadAllAddons: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  installAddon: mocks.installAddon,
  getInstalledAddons: mocks.getInstalledAddons,
  toggleAddon: vi.fn(),
  uninstallAddon: mocks.uninstallAddon,
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function createWrapper(queryClient = createQueryClient()) {
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

describe("useAddonActions uninstall", () => {
  const installed = { metadata: { id: "slow-addon", name: "Slow Add-on", permissions: [] } };
  const other = { metadata: { id: "other-addon", name: "Other Add-on", permissions: [] } };

  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getInstalledAddons.mockResolvedValue([installed]);
    mocks.reloadAllAddons.mockResolvedValue(undefined);
  });

  async function renderWithAddons(queryClient = createQueryClient()) {
    const hook = renderHook(() => useAddonActions(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(hook.result.current.installedAddons.length).toBeGreaterThan(0));
    return hook;
  }

  it("sends one uninstall while a removal of that add-on is running", async () => {
    const removal = deferred();
    mocks.uninstallAddon.mockReturnValue(removal.promise);
    const { result } = await renderWithAddons();

    let first!: Promise<void>;
    act(() => {
      first = result.current.handleUninstallAddon("slow-addon");
      // Same render, so render state can't stop this one.
      void result.current.handleUninstallAddon("slow-addon");
    });
    await act(async () => {
      void result.current.handleUninstallAddon("slow-addon");
    });
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual(["slow-addon"]));

    mocks.getInstalledAddons.mockResolvedValue([]);
    await act(async () => {
      removal.resolve();
      await first;
    });
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual([]));
    expect(mocks.reloadAllAddons).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Addon uninstalled" }),
    );
  });

  it("still sees a running removal after the page is opened again", async () => {
    const removal = deferred();
    mocks.uninstallAddon.mockReturnValue(removal.promise);
    const queryClient = createQueryClient();
    const firstPage = await renderWithAddons(queryClient);
    act(() => {
      void firstPage.result.current.handleUninstallAddon("slow-addon");
    });
    firstPage.unmount();

    const { result } = await renderWithAddons(queryClient);
    await act(async () => {
      void result.current.handleUninstallAddon("slow-addon");
    });
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual(["slow-addon"]));

    await act(async () => removal.resolve());
  });

  it("drops the removed add-on even if the list refetch fails", async () => {
    mocks.uninstallAddon.mockResolvedValue(undefined);
    const { result } = await renderWithAddons();
    // A card rendered before the removal keeps this handler.
    const staleHandler = result.current.handleUninstallAddon;
    const refetch = deferred();
    mocks.getInstalledAddons.mockImplementation(async () => {
      await refetch.promise;
      throw new Error("list failed");
    });

    let first!: Promise<void>;
    await act(async () => {
      first = staleHandler("slow-addon");
    });
    // The list refreshes in the background: the toast and runtime reload don't wait for it.
    expect(mocks.getInstalledAddons).toHaveBeenCalledTimes(2);
    expect(mocks.reloadAllAddons).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Addon uninstalled" }),
    );
    await act(async () => {
      refetch.resolve();
      await first;
    });
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual([]));
    await act(() => staleHandler("slow-addon"));

    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
    expect(result.current.installedAddons).toEqual([]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("ignores a list request that started before the removal", async () => {
    const removal = deferred();
    const oldList = deferred<unknown[]>();
    mocks.uninstallAddon.mockReturnValue(removal.promise);
    const queryClient = createQueryClient();
    const firstPage = await renderWithAddons(queryClient);
    mocks.getInstalledAddons.mockReturnValueOnce(oldList.promise).mockResolvedValue([]);

    let first!: Promise<void>;
    act(() => {
      void firstPage.result.current.loadInstalledAddons();
      first = firstPage.result.current.handleUninstallAddon("slow-addon");
    });
    await waitFor(() => expect(mocks.getInstalledAddons).toHaveBeenCalledTimes(2));
    // With the page closed, nothing refetches the list after the removal.
    firstPage.unmount();
    await act(async () => {
      removal.resolve();
      await first;
      oldList.resolve([installed]);
    });
    expect(queryClient.getQueryData([QueryKeys.INSTALLED_ADDONS])).toEqual([]);

    const { result } = renderHook(() => useAddonActions(), {
      wrapper: createWrapper(queryClient),
    });
    await act(() => result.current.handleUninstallAddon("slow-addon"));
    expect(result.current.installedAddons).toEqual([]);
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
  });

  it("tracks removals of different add-ons separately", async () => {
    const removalA = deferred();
    const removalB = deferred();
    mocks.uninstallAddon
      .mockReturnValueOnce(removalA.promise)
      .mockReturnValueOnce(removalB.promise);
    mocks.getInstalledAddons.mockResolvedValue([installed, other]);
    const { result } = await renderWithAddons();

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.handleUninstallAddon("slow-addon");
      second = result.current.handleUninstallAddon("other-addon");
    });
    expect(mocks.uninstallAddon.mock.calls).toEqual([["slow-addon"], ["other-addon"]]);
    await waitFor(() =>
      expect(result.current.uninstallingAddonIds).toEqual(["slow-addon", "other-addon"]),
    );

    mocks.getInstalledAddons.mockResolvedValue([other]);
    await act(async () => {
      removalA.resolve();
      await first;
    });
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual(["other-addon"]));
    expect(result.current.installedAddons).toEqual([other]);
    await act(async () => {
      void result.current.handleUninstallAddon("other-addon");
    });
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(2);

    mocks.getInstalledAddons.mockResolvedValue([]);
    await act(async () => {
      removalB.resolve();
      await second;
    });
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual([]));
  });

  it("clears the running state after a failure so the removal can be retried", async () => {
    mocks.uninstallAddon.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(undefined);
    const { result } = await renderWithAddons();

    await act(() => result.current.handleUninstallAddon("slow-addon"));
    await waitFor(() => expect(result.current.uninstallingAddonIds).toEqual([]));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));

    await act(() => result.current.handleUninstallAddon("slow-addon"));
    expect(mocks.uninstallAddon).toHaveBeenCalledTimes(2);
    expect(mocks.reloadAllAddons).toHaveBeenCalledTimes(1);
  });
});
