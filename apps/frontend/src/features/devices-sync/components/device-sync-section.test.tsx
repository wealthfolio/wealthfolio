import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreOperation } from "../hooks/use-restore-operation";
import { DeviceSyncSection } from "./device-sync-section";

const hookMocks = vi.hoisted(() => ({
  useSyncStatus: vi.fn(),
  useDevices: vi.fn(),
  useSyncActions: vi.fn(),
  useRenameDevice: vi.fn(),
  useRevokeDevice: vi.fn(),
  getPairingSourceStatus: vi.fn(),
}));

type RestoreHandler = (event: { payload: RestoreOperation }) => void;

const adapterMocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  getDeviceSyncRestore: vi.fn(),
  startDeviceSyncRestore: vi.fn(),
  approveDeviceSyncRestore: vi.fn(),
  retryDeviceSyncRestore: vi.fn(),
  cancelDeviceSyncRestore: vi.fn(),
  listenDeviceSyncRestore: vi.fn(),
  handlers: [] as RestoreHandler[],
}));

interface MutationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  error?: unknown;
}

interface SyncActionsMock {
  stopBgSync: MutationMock;
  startBgSync: MutationMock;
  generateSnapshot: MutationMock;
  reinitializeSync: MutationMock;
  resetSync: MutationMock;
}

// The section uses the real restore controller; only transport is mocked.
vi.mock("../hooks", async () => {
  const restore = await vi.importActual<typeof import("../hooks/use-restore-operation")>(
    "../hooks/use-restore-operation",
  );
  return {
    useSyncStatus: hookMocks.useSyncStatus,
    useDevices: hookMocks.useDevices,
    useSyncActions: hookMocks.useSyncActions,
    useRenameDevice: hookMocks.useRenameDevice,
    useRevokeDevice: hookMocks.useRevokeDevice,
    useRestoreOperation: restore.useRestoreOperation,
  };
});

vi.mock("../services/sync-service", () => ({
  syncService: {
    getPairingSourceStatus: hookMocks.getPairingSourceStatus,
  },
}));

vi.mock("@/adapters", () => adapterMocks);

const pairingMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("./pairing-flow", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function WizardStub({ title }: { title?: string }) {
    useEffect(() => {
      pairingMounts.count += 1;
    }, []);
    return <div>{title ?? "Setup wizard"}</div>;
  }
  return {
    AddDeviceWizard: WizardStub,
    JoinDeviceWizard: WizardStub,
    WaitingState: ({ title }: { title: string }) => <div>{title}</div>,
    PairingResult: ({ title }: { title?: string }) => <div>{title}</div>,
  };
});

vi.mock("./recovery-dialog", () => ({
  RecoveryDialog: () => null,
}));

let revision = 0;

function restoreOp(overrides: Partial<RestoreOperation> = {}): RestoreOperation {
  revision += 1;
  return {
    operationId: "op-1",
    revision,
    phase: "awaiting_consent",
    snapshot: { snapshotId: "snap-1", oplogSeq: 42, createdAt: "2026-09-21T10:00:00Z" },
    error: null,
    replaced: false,
    ...overrides,
  };
}

/** Delivers a runtime event, as another tab, window or the pairing flow would. */
async function emit(operation: RestoreOperation) {
  await act(async () => {
    adapterMocks.handlers.forEach((handler) => handler({ payload: operation }));
    await Promise.resolve();
  });
}

function readyStatus(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe("DeviceSyncSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revision = 0;
    adapterMocks.handlers = [];
    adapterMocks.listenDeviceSyncRestore.mockImplementation((handler: RestoreHandler) => {
      adapterMocks.handlers.push(handler);
      return Promise.resolve(() => {
        adapterMocks.handlers = adapterMocks.handlers.filter((h) => h !== handler);
        return Promise.resolve();
      });
    });
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(null);

    hookMocks.useRenameDevice.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    hookMocks.useRevokeDevice.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    hookMocks.useDevices.mockReturnValue({ data: [], isLoading: false, error: null });
    hookMocks.useSyncActions.mockReturnValue(createActions());
    hookMocks.getPairingSourceStatus.mockResolvedValue({
      status: "ready",
      message: "Ready",
      localCursor: 1,
      serverCursor: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    fireEvent.click(screen.getByRole("button", { name: "Connect this device" }));

    expect(hookMocks.getPairingSourceStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getAllByText("Connect this device").length).toBeGreaterThan(1);
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Connect another device" }));

    await waitFor(() => {
      expect(hookMocks.getPairingSourceStatus).toHaveBeenCalledTimes(1);
    });
    expect(reinitializeSync.mutateAsync).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });
  it("routes the recurring check through the runtime and approves its consent once", async () => {
    vi.useFakeTimers();
    // Like the runtime, reads return whatever the last command produced.
    let current: RestoreOperation | null = null;
    adapterMocks.getDeviceSyncRestore.mockImplementation(() => Promise.resolve(current));
    adapterMocks.startDeviceSyncRestore.mockImplementation(() => {
      current ??= restoreOp();
      return Promise.resolve(current);
    });
    adapterMocks.approveDeviceSyncRestore.mockImplementation(() => {
      current = restoreOp({ phase: "replacing" });
      return Promise.resolve(current);
    });
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flushAsyncWork();

    expect(adapterMocks.startDeviceSyncRestore).toHaveBeenCalledTimes(1);
    expect(adapterMocks.startDeviceSyncRestore).toHaveBeenCalledWith(false);
    await flushAsyncWork();
    expect(screen.getByText("Replace the data in this profile?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Back up this profile first/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace data" }));
    await flushAsyncWork();
    expect(adapterMocks.approveDeviceSyncRestore).toHaveBeenCalledTimes(1);
    expect(adapterMocks.approveDeviceSyncRestore).toHaveBeenCalledWith("op-1", false);
    await flushAsyncWork();
    expect(screen.getByText("Replacing data on this device")).toBeInTheDocument();

    // The recurring check does not start or prompt again while the runtime owns it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(adapterMocks.startDeviceSyncRestore).toHaveBeenCalledTimes(1);
  });

  it("delegates the backup to the runtime", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(restoreOp());
    adapterMocks.approveDeviceSyncRestore.mockResolvedValue(restoreOp({ phase: "backing_up" }));
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Back up and replace" }));

    await waitFor(() =>
      expect(adapterMocks.approveDeviceSyncRestore).toHaveBeenCalledWith("op-1", true),
    );
    expect(await screen.findByText("Backing up this profile")).toBeInTheDocument();
  });

  // Regression: pairing and the recurring check used to own restoration
  // separately, so each could show its own replacement prompt.
  // Regression: each sync state rendered its own pairing dialog, so when keys
  // arrived (REGISTERED -> READY) the window closed and reopened mid-pairing.
  it("keeps the pairing window open while the sync state changes", async () => {
    pairingMounts.count = 0;
    const registered = {
      ...readyStatus(),
      syncState: "REGISTERED",
      device: { trustState: "untrusted" },
    };
    hookMocks.useSyncStatus.mockReturnValue(registered);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DeviceSyncSection />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect this device" }));
    await flushAsyncWork();
    const dialog = screen.getByRole("dialog");
    expect(pairingMounts.count).toBe(1);

    hookMocks.useSyncStatus.mockReturnValue(readyStatus({ device: { trustState: "trusted" } }));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <DeviceSyncSection />
      </QueryClientProvider>,
    );
    await flushAsyncWork();

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(pairingMounts.count).toBe(1);
  });

  // An automatic restore that needs approval opens the one setup dialog, on the
  // recovery steps only: nothing was paired, so there is no Connect step.
  it("asks for approval in the setup wizard's recovery steps", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({ operationId: "op-recover-steps" }),
    );
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());
    renderWithQueryClient(<DeviceSyncSection />);

    expect(await screen.findByRole("button", { name: "Back up and replace" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByTestId("wizard-step-connect")).not.toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-download")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("wizard-step-apply")).toHaveAttribute("aria-current", "step");
  });

  // Preparing this device is part of the wizard's Connect step, not a separate popup.
  it("shows a failed preparation on the wizard's Connect step", async () => {
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());
    hookMocks.getPairingSourceStatus.mockRejectedValue(new Error("offline"));
    renderWithQueryClient(<DeviceSyncSection />);

    fireEvent.click(screen.getByRole("button", { name: "Connect another device" }));
    await flushAsyncWork();

    expect(screen.getByText("We couldn't finish getting this device ready.")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-connect")).toHaveAttribute("data-state", "failed");
  });

  // The pairing window stays mounted and shows its own restore, so the section
  // must neither prompt a second time nor start a recurring check alongside it.
  it("leaves a pairing restore to the pairing window", async () => {
    vi.useFakeTimers();
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());
    renderWithQueryClient(<DeviceSyncSection />);

    fireEvent.click(screen.getByRole("button", { name: "Connect another device" }));
    await flushAsyncWork();
    expect(screen.getAllByText("Connect another device").length).toBeGreaterThan(1);

    // Pairing hands off to the runtime while the engine still reports stale_cursor.
    await emit(restoreOp());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushAsyncWork();

    expect(adapterMocks.startDeviceSyncRestore).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back up and replace" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Connect another device").length).toBeGreaterThan(1);
  });

  it("follows approval from another tab instead of prompting again", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(restoreOp());
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());
    renderWithQueryClient(<DeviceSyncSection />);
    expect(await screen.findByRole("button", { name: "Back up and replace" })).toBeInTheDocument();
    await waitFor(() => expect(adapterMocks.handlers.length).toBeGreaterThan(0));

    await emit(restoreOp({ phase: "replacing" }));

    expect(await screen.findByText("Replacing data on this device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up and replace" })).not.toBeInTheDocument();
    expect(adapterMocks.approveDeviceSyncRestore).not.toHaveBeenCalled();
  });

  it("offers Finish setup after cancellation instead of reopening the prompt", async () => {
    vi.useFakeTimers();
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(restoreOp({ phase: "cancelled" }));
    adapterMocks.startDeviceSyncRestore.mockResolvedValue(restoreOp({ operationId: "op-2" }));
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    await flushAsyncWork();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flushAsyncWork();

    expect(adapterMocks.startDeviceSyncRestore).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back up and replace" })).not.toBeInTheDocument();
    const finish = screen.getByRole("button", { name: "Finish setup" });

    fireEvent.click(finish);
    await flushAsyncWork();
    expect(adapterMocks.startDeviceSyncRestore).toHaveBeenCalledWith(true);
    await flushAsyncWork();
    expect(screen.getByRole("button", { name: "Back up and replace" })).toBeInTheDocument();
  });

  it("keeps an automatic check in the background until it needs the user", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({ operationId: "op-background-transfer", phase: "transferring" }),
    );
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Show progress" }));
    expect(await screen.findByText("Transferring your data")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(screen.queryByText("Transferring your data")).not.toBeInTheDocument(),
    );
    expect(adapterMocks.cancelDeviceSyncRestore).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show progress" })).toBeInTheDocument();
  });

  // Review finding: a transient failure of an automatic check opened a modal
  // the user never asked for.
  it("keeps a failed automatic check in the banner", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({
        operationId: "op-background-failed",
        phase: "failed",
        error: { code: "TRANSFER_FAILED", message: "connection reset", retry: "transfer" },
      }),
    );
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    expect(await screen.findByText("Setup stopped before it finished.")).toBeInTheDocument();
    expect(screen.queryByText("The transfer didn't finish")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show progress" }));
    expect(await screen.findByText("The transfer didn't finish")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // Review finding: "Start again" in the recovery dialog started an attempt the
  // dialog then hid as an automatic check.
  it("keeps showing an attempt started again from the dialog", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({
        operationId: "op-unavailable",
        phase: "failed",
        error: { code: "SNAPSHOT_UNAVAILABLE", message: "gone", retry: "new_attempt" },
      }),
    );
    adapterMocks.startDeviceSyncRestore.mockResolvedValue(
      restoreOp({ operationId: "op-started-again", phase: "transferring" }),
    );
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Show progress" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start again" }));
    await flushAsyncWork();

    expect(adapterMocks.startDeviceSyncRestore).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Transferring your data")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-banner")).not.toBeInTheDocument();
  });

  // Review finding: with a Ready restore and a lingering "waiting for snapshot"
  // engine status, the background check asked again every couple of seconds.
  it("does not keep asking once a restore is Ready and nothing requires another", async () => {
    vi.useFakeTimers();
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({ operationId: "op-settled", phase: "ready", replaced: true }),
    );
    hookMocks.useSyncStatus.mockReturnValue(
      readyStatus({
        engineStatus: {
          lastCycleStatus: "wait_snapshot",
          bootstrapRequired: false,
          backgroundRunning: true,
        },
      }),
    );

    renderWithQueryClient(<DeviceSyncSection />);
    await flushAsyncWork();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(adapterMocks.startDeviceSyncRestore).not.toHaveBeenCalled();
  });

  // Regression: a check that finished without restoring anything popped up
  // "Ready" again right after the user closed the real restore.
  it("never pops up a check that found nothing to restore", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      restoreOp({ operationId: "op-noop", phase: "ready", replaced: false }),
    );
    hookMocks.useSyncStatus.mockReturnValue(readyStatus());

    renderWithQueryClient(<DeviceSyncSection />);
    await waitFor(() => expect(adapterMocks.getDeviceSyncRestore).toHaveBeenCalled());
    await flushAsyncWork();

    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.queryByTestId("restore-banner")).not.toBeInTheDocument();
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
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(50);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}
