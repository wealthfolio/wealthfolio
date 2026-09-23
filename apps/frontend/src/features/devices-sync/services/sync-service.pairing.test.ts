import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  getDeviceSyncState: vi.fn(),
  enableDeviceSync: vi.fn(),
  clearDeviceSyncData: vi.fn(),
  reinitializeDeviceSync: vi.fn(),
  getSyncEngineStatus: vi.fn(),
  deviceSyncGenerateSnapshotNow: vi.fn(),
  syncTriggerCycle: vi.fn(),
  deviceSyncStartBackgroundEngine: vi.fn(),
  deviceSyncStopBackgroundEngine: vi.fn(),
  getDevice: vi.fn(),
  listDevices: vi.fn(),
  updateDevice: vi.fn(),
  deleteDevice: vi.fn(),
  revokeDevice: vi.fn(),
  resetTeamSync: vi.fn(),
  createPairing: vi.fn(),
  getPairing: vi.fn(),
  approvePairing: vi.fn(),
  completePairingWithTransfer: vi.fn(),
  cancelPairing: vi.fn(),
  claimPairing: vi.fn(),
  getPairingMessages: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  getRootKey: vi.fn(),
  getKeyVersion: vi.fn(),
  setE2EECredentials: vi.fn(),
  getDeviceId: vi.fn(),
  clearRootKey: vi.fn(),
  getIdentity: vi.fn(),
  setIdentity: vi.fn(),
  getServerKeyVersion: vi.fn(),
  getDeviceSecretKey: vi.fn(),
  getDevicePublicKey: vi.fn(),
}));

const cryptoMocks = vi.hoisted(() => ({
  generatePairingCode: vi.fn(),
  hashPairingCode: vi.fn(),
  generateEphemeralKeypair: vi.fn(),
  computeSharedSecret: vi.fn(),
  deriveSessionKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  computeSAS: vi.fn(),
  hmacSha256: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("../storage/keyring", () => ({ syncStorage: storageMocks }));
vi.mock("../crypto", () => cryptoMocks);

import { SyncErrorCodes, type PairingSession } from "../types";
import { syncService } from "./sync-service";

describe("syncService pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completePairingWithTransfer encrypts key bundle and calls backend", async () => {
    const session: PairingSession = {
      pairingId: "pair_1",
      code: "123456",
      ephemeralSecretKey: "esk",
      ephemeralPublicKey: "epk",
      claimerPublicKey: "claimer_pub",
      claimerDeviceId: "dev_2",
      sessionKey: "session_key",
      keyVersion: 7,
      expiresAt: new Date(Date.now() + 60_000),
      status: "claimed",
      requireSas: true,
    };

    storageMocks.getRootKey.mockResolvedValue("root_key");
    storageMocks.getKeyVersion.mockResolvedValue(7);
    cryptoMocks.encrypt.mockResolvedValue("encrypted_bundle");
    cryptoMocks.computeSAS.mockResolvedValue("sas");
    cryptoMocks.hmacSha256.mockResolvedValue("signature");
    adapterMocks.completePairingWithTransfer.mockResolvedValue({ success: true });

    const result = await syncService.completePairingWithTransfer(session);

    expect(adapterMocks.completePairingWithTransfer).toHaveBeenCalledWith(
      "pair_1",
      "encrypted_bundle",
      "sas",
      "signature",
    );
    expect(result.remoteSeedPresent).toBeNull();
  });

  it("maps restore-required snapshot errors to a typed sync error", async () => {
    const session: PairingSession = {
      pairingId: "pair_restore",
      code: "123456",
      ephemeralSecretKey: "esk",
      ephemeralPublicKey: "epk",
      claimerPublicKey: "claimer_pub",
      claimerDeviceId: "dev_2",
      sessionKey: "session_key",
      keyVersion: 7,
      expiresAt: new Date(Date.now() + 60_000),
      status: "claimed",
      requireSas: true,
    };

    storageMocks.getRootKey.mockResolvedValue("root_key");
    storageMocks.getKeyVersion.mockResolvedValue(7);
    cryptoMocks.encrypt.mockResolvedValue("encrypted_bundle");
    cryptoMocks.computeSAS.mockResolvedValue("sas");
    cryptoMocks.hmacSha256.mockResolvedValue("signature");
    adapterMocks.completePairingWithTransfer.mockRejectedValue(
      new Error(
        "SYNC_SOURCE_RESTORE_REQUIRED: Local sync state is ahead of the last confirmed sync state on the server. Use this device to restore sync before connecting another device.",
      ),
    );

    await expect(syncService.completePairingWithTransfer(session)).rejects.toMatchObject({
      code: SyncErrorCodes.SOURCE_RESTORE_REQUIRED,
    });
  });
});
