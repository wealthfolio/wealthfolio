import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceSyncSection } from "./device-sync-section";

const hookMocks = vi.hoisted(() => ({
  backupDatabase: vi.fn(),
  useSyncStatus: vi.fn(),
  useDevices: vi.fn(),
  useSyncActions: vi.fn(),
  useRenameDevice: vi.fn(),
  useRevokeDevice: vi.fn(),
  getPairingSourceStatus: vi.fn(),
  pairingBootstrapActive: false,
  pairingCompletes: false,
  pairingFails: false,
}));

interface MutationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  error?: unknown;
}

interface SyncActionsMock {
  stopBgSync: MutationMock;
  startBgSync: MutationMock;
  bootstrapSync: MutationMock;
  generateSnapshot: MutationMock;
  reinitializeSync: MutationMock;
  resetSync: MutationMock;
}

vi.mock("../hooks", () => ({
  useSyncStatus: hookMocks.useSyncStatus,
  useDevices: hookMocks.useDevices,
  useSyncActions: hookMocks.useSyncActions,
  useRenameDevice: hookMocks.useRenameDevice,
  useRevokeDevice: hookMocks.useRevokeDevice,
}));

vi.mock("../services/sync-service", () => ({
  syncService: {
    getPairingSourceStatus: hookMocks.getPairingSourceStatus,
  },
}));

vi.mock("@/adapters", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  backupDatabase: hookMocks.backupDatabase,
}));

vi.mock("./pairing-flow", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    PairingFlow: ({
      title,
      onBootstrapStateChange,
      onComplete,
      onCancel,
    }: {
      title?: string;
      onBootstrapStateChange?: (state: "idle" | "active" | "failed") => void;
      onComplete?: () => void;
      onCancel?: () => void;
    }) => {
      React.useEffect(() => {
        if (hookMocks.pairingFails) {
          onBootstrapStateChange?.("failed");
          return () => onBootstrapStateChange?.("idle");
        }
        if (hookMocks.pairingCompletes) {
          onBootstrapStateChange?.("active");
          onComplete?.();
          return () => onBootstrapStateChange?.("idle");
        }
        if (!hookMocks.pairingBootstrapActive) return;
        onBootstrapStateChange?.("active");
        return () => onBootstrapStateChange?.("idle");
      }, [onBootstrapStateChange, onComplete]);

      return (
        <div>
          {title ?? "Pairing Flow"}
          {hookMocks.pairingFails && <button onClick={onCancel}>Done</button>}
        </div>
      );
    },
    WaitingState: ({ title }: { title: string }) => <div>{title}</div>,
  };
});

vi.mock("./recovery-dialog", () => ({
  RecoveryDialog: () => null,
}));

describe("DeviceSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.pairingBootstrapActive = false;
    hookMocks.pairingCompletes = false;
    hookMocks.pairingFails = false;

    hookMocks.useRenameDevice.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    hookMocks.useRevokeDevice.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
  });

  it("opens the claimer flow directly for an untrusted READY device", async () => {
    hookMocks.useSyncStatus.mockReturnValue({
      isLoading: false,
      error: null,
      syncState: "READY",
      trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
      device: { trustState: "untrusted" },
      engineStatus: null,
      refetch: vi.fn(),
    });
    hookMocks.useDevices.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    hookMocks.useSyncActions.mockReturnValue(createActions());

    renderWithQueryClient(<DeviceSyncSection />);

    fireEvent.click(screen.getByRole("button", { name: "Connect This Device" }));

    expect(hookMocks.getPairingSourceStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getAllByText("Connect This Device").length).toBeGreaterThan(1);
    });
  });

  it("keeps ready-state overwrite actions responsive", async () => {
    vi.useFakeTimers();
    try {
      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch: vi.fn(),
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await flushAsyncWork();

      expect(screen.getByRole("button", { name: "Back up first" }).parentElement).toHaveClass(
        "max-sm:[&>button]:whitespace-normal",
        "sm:flex-wrap",
      );
      let finishBackup!: (value: { filename: string }) => void;
      hookMocks.backupDatabase.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishBackup = resolve;
          }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Back up first" }));
      expect(hookMocks.backupDatabase).toHaveBeenCalledTimes(1);
      expect(bootstrapSync.mutateAsync).not.toHaveBeenCalledWith({ allowOverwrite: true });
      await act(async () => {
        finishBackup({ filename: "managed.db" });
      });
      await flushAsyncWork();
      expect(bootstrapSync.mutateAsync).toHaveBeenCalledWith({ allowOverwrite: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires confirmation when any other non-revoked device exists", async () => {
    const reinitializeSync = {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
      error: null,
    };

    hookMocks.useSyncStatus.mockReturnValue({
      isLoading: false,
      error: null,
      syncState: "READY",
      trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
      device: { trustState: "trusted" },
      engineStatus: null,
      refetch: vi.fn(),
    });
    hookMocks.useDevices.mockReturnValue({
      data: [
        { id: "current", displayName: "This device", trustState: "trusted", isCurrent: true },
        { id: "other", displayName: "Other device", trustState: "untrusted", isCurrent: false },
      ],
      isLoading: false,
      error: null,
    });
    hookMocks.useSyncActions.mockReturnValue(createActions({ reinitializeSync }));
    hookMocks.getPairingSourceStatus.mockResolvedValue({
      status: "restore_required",
      message: "Restore required",
      localCursor: 11,
      serverCursor: 8,
    });

    renderWithQueryClient(<DeviceSyncSection />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));

    await waitFor(() => {
      expect(hookMocks.getPairingSourceStatus).toHaveBeenCalledTimes(1);
    });
    expect(reinitializeSync.mutateAsync).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });
  it("does not auto-open the ready-state bootstrap prompt while pairing bootstrap owns restore", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.pairingBootstrapActive = true;

      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch: vi.fn(),
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));
        await Promise.resolve();
      });
      expect(screen.getAllByText("Connect Another Device").length).toBeGreaterThan(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(bootstrapSync.mutateAsync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("discards a ready-state bootstrap result if pairing opens while the check is in flight", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.pairingBootstrapActive = true;

      let resolveBootstrap!: (value: unknown) => void;
      const bootstrapPromise = new Promise((resolve) => {
        resolveBootstrap = resolve;
      });
      const bootstrapSync = {
        mutateAsync: vi.fn(() => bootstrapPromise),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch: vi.fn(),
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(bootstrapSync.mutateAsync).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));
        await Promise.resolve();
      });

      await act(async () => {
        resolveBootstrap({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        });
        await bootstrapPromise;
      });

      expect(screen.queryByText("Replace data on this device?")).not.toBeInTheDocument();
      expect(screen.queryByText("This device already has data")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides an already-open ready-state bootstrap prompt when pairing opens", async () => {
    vi.useFakeTimers();
    try {
      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 86,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch: vi.fn(),
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText("Replace data on this device?")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText("Connect Another Device"));
        await Promise.resolve();
      });

      expect(hookMocks.getPairingSourceStatus).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Replace data on this device?")).not.toBeInTheDocument();
      expect(screen.queryByText("This device already has data")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen the ready-state replace prompt after pairing overwrite completes", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.pairingCompletes = true;

      const refetch = vi.fn();
      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch,
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));
      });
      await flushAsyncWork();

      expect(refetch).toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(bootstrapSync.mutateAsync).not.toHaveBeenCalled();
      expect(screen.queryByText("Replace data on this device?")).not.toBeInTheDocument();
      expect(screen.queryByText("This device already has data")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows manual bootstrap retry after pairing prompt suppression", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.pairingCompletes = true;

      const refetch = vi.fn();
      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch,
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));
      });
      await flushAsyncWork();

      expect(refetch).toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await Promise.resolve();
      });

      expect(bootstrapSync.mutateAsync).toHaveBeenCalledWith({ allowOverwrite: false });
      expect(screen.getByText("Replace data on this device?")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows manual bootstrap retry after failed pairing bootstrap is dismissed", async () => {
    vi.useFakeTimers();
    try {
      hookMocks.pairingFails = true;

      const bootstrapSync = {
        mutateAsync: vi.fn().mockResolvedValue({
          status: "overwrite_required",
          localRows: 12,
          nonEmptyTables: [{ table: "accounts", rows: 1 }],
        }),
        isPending: false,
        error: null,
      };

      hookMocks.useSyncStatus.mockReturnValue({
        isLoading: false,
        error: null,
        syncState: "READY",
        trustedDevices: [{ id: "trusted-1", name: "Laptop", platform: "mac", lastSeenAt: null }],
        device: { trustState: "trusted" },
        engineStatus: {
          lastCycleStatus: "stale_cursor",
          bootstrapRequired: true,
          backgroundRunning: false,
        },
        engineIsFetching: false,
        refetch: vi.fn(),
      });
      hookMocks.useDevices.mockReturnValue({
        data: [],
        isLoading: false,
        error: null,
      });
      hookMocks.useSyncActions.mockReturnValue(createActions({ bootstrapSync }));
      hookMocks.getPairingSourceStatus.mockResolvedValue({
        status: "ready",
        message: "Ready",
        localCursor: 0,
        serverCursor: 0,
      });

      renderWithQueryClient(<DeviceSyncSection />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect Another Device" }));
      });
      await flushAsyncWork();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
      });
      await flushAsyncWork();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await Promise.resolve();
      });

      expect(bootstrapSync.mutateAsync).toHaveBeenCalledWith({ allowOverwrite: false });
      expect(screen.getByText("Replace data on this device?")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createActions(overrides?: Partial<SyncActionsMock>): SyncActionsMock {
  return {
    stopBgSync: {
      mutateAsync: vi.fn(),
      isPending: false,
    },
    startBgSync: {
      mutateAsync: vi.fn(),
      isPending: false,
    },
    bootstrapSync: {
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    },
    generateSnapshot: {
      mutateAsync: vi.fn(),
      isPending: false,
    },
    reinitializeSync: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
      error: null,
    },
    resetSync: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    },
    ...overrides,
  };
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
