import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePairingClaimer } from "./use-pairing-claimer";

const adapterMocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  beginPairingRestore: vi.fn(),
  getDeviceSyncRestore: vi.fn(),
  startDeviceSyncRestore: vi.fn(),
  approveDeviceSyncRestore: vi.fn(),
  retryDeviceSyncRestore: vi.fn(),
  cancelDeviceSyncRestore: vi.fn(),
  listenDeviceSyncRestore: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  syncService: {
    claimPairingSession: vi.fn(),
    pollForKeyBundle: vi.fn(),
    cancelPairing: vi.fn(),
    clearSyncData: vi.fn(),
  },
}));

const storageMocks = vi.hoisted(() => ({
  syncStorage: {
    setE2EECredentials: vi.fn(),
  },
}));

const cryptoMocks = vi.hoisted(() => ({
  computeSAS: vi.fn(),
  hmacSha256: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("../services/sync-service", () => serviceMocks);
vi.mock("../storage/keyring", () => storageMocks);
vi.mock("../crypto", () => cryptoMocks);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const restoreOperation = {
  operationId: "op-1",
  revision: 2,
  phase: "awaiting_consent",
  snapshot: { snapshotId: "snap-1", oplogSeq: 42, createdAt: "2026-04-29T12:01:00Z" },
  error: null,
  replaced: false,
};

describe("usePairingClaimer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    serviceMocks.syncService.claimPairingSession.mockResolvedValue({
      pairingId: "pair-1",
      deviceId: "device-1",
      code: "ABC123",
      ephemeralSecretKey: "ephemeral-secret",
      ephemeralPublicKey: "ephemeral-public",
      issuerPublicKey: "issuer-public",
      sessionKey: "session-key",
      e2eeKeyVersion: 2,
      requireSas: true,
      expiresAt: new Date("2026-04-29T12:00:00Z"),
      status: "approved",
    });
    serviceMocks.syncService.pollForKeyBundle.mockResolvedValue({
      received: true,
      keyBundle: {
        version: 1,
        rootKey: "root-key",
        keyVersion: 2,
      },
      keyBundleCreatedAt: "2026-04-29T12:01:00Z",
      status: "completed",
    });
    serviceMocks.syncService.cancelPairing.mockResolvedValue({ success: true });
    serviceMocks.syncService.clearSyncData.mockResolvedValue(undefined);
    storageMocks.syncStorage.setE2EECredentials.mockResolvedValue(undefined);
    cryptoMocks.computeSAS.mockResolvedValue("123456");
    cryptoMocks.hmacSha256.mockResolvedValue("proof");
    adapterMocks.listenDeviceSyncRestore.mockResolvedValue(async () => {});
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(null);
    adapterMocks.beginPairingRestore.mockResolvedValue(restoreOperation);
  });

  it("hands restoration to the runtime after key exchange instead of reporting success", async () => {
    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });

    await waitFor(() => expect(result.current.step).toBe("restoring"));
    expect(adapterMocks.beginPairingRestore).toHaveBeenCalledTimes(1);
    expect(adapterMocks.beginPairingRestore).toHaveBeenCalledWith(
      "pair-1",
      "proof",
      "2026-04-29T12:01:00Z",
    );
    expect(storageMocks.syncStorage.setE2EECredentials).toHaveBeenCalledTimes(1);
    expect(result.current.operation?.operationId).toBe("op-1");
    expect(result.current.operation?.phase).toBe("awaiting_consent");
  });

  it("leaves a handed-off restore running when the pairing window is dismissed", async () => {
    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });
    await waitFor(() => expect(result.current.step).toBe("restoring"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(serviceMocks.syncService.cancelPairing).not.toHaveBeenCalled();
    expect(serviceMocks.syncService.clearSyncData).not.toHaveBeenCalled();
    expect(adapterMocks.cancelDeviceSyncRestore).not.toHaveBeenCalled();
    expect(result.current.step).toBe("enter_code");
  });

  it("cancels the pairing session when dismissed before keys arrive", async () => {
    serviceMocks.syncService.pollForKeyBundle.mockResolvedValue({
      received: false,
      status: "claimed",
    });
    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });
    await waitFor(() => expect(result.current.step).toBe("waiting_keys"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(serviceMocks.syncService.cancelPairing).toHaveBeenCalledWith("pair-1");
    expect(adapterMocks.beginPairingRestore).not.toHaveBeenCalled();
  });

  it("reports an error when pairing confirmation fails", async () => {
    adapterMocks.beginPairingRestore.mockRejectedValue(new Error("confirm failed"));

    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });

    await waitFor(() => expect(result.current.step).toBe("error"));
    expect(result.current.error).toBe("confirm failed");
    expect(result.current.operation).toBeNull();
  });

  // A mistyped or expired code returns to code entry instead of a failure screen.
  it("keeps the user on code entry when the code is rejected", async () => {
    serviceMocks.syncService.claimPairingSession.mockRejectedValueOnce(
      new Error("Invalid pairing code"),
    );
    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });

    expect(result.current.step).toBe("enter_code");
    expect(result.current.error).toBe("Invalid pairing code");
  });
});
