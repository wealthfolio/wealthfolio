import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  stage: vi.fn(),
  cleanup: vi.fn(),
  appDataDir: vi.fn(),
  join: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./core", () => ({
  invoke: mocks.invoke,
  tauriInvoke: mocks.invoke,
  logger: { error: vi.fn() },
}));
vi.mock("./files", () => ({
  stagePickedDatabaseFileForRestore: mocks.stage,
  removeAppDataPath: mocks.cleanup,
  saveAppDataFileViaPicker: mocks.save,
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: mocks.appDataDir, join: mocks.join }));

import {
  exportDatabaseBackup,
  inspectDatabaseBackup,
  inspectSavedDatabaseBackup,
  restoreDatabaseBackupImport,
} from "./settings";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.stage.mockResolvedValue({
    relativePath: "pending-restores/test/restore.db",
    pendingDir: "pending-restores/test",
  });
  mocks.join.mockImplementation(async (base: string, relative: string) => `${base}/${relative}`);
});

it.each([true, false])("reports native picker completion accurately: %s", async (saved) => {
  mocks.invoke.mockResolvedValueOnce({
    relativePath: "pending-exports/test/backup.wfbackup",
    filename: "backup.wfbackup",
  });
  mocks.save.mockResolvedValueOnce(saved);
  const password = "  keep these spaces  ";
  expect(await exportDatabaseBackup("selected.db", password, false)).toBe(saved);
  expect(mocks.invoke).toHaveBeenCalledWith("export_database_backup", {
    filename: "selected.db",
    password,
    unencrypted: false,
  });
  expect(mocks.save).toHaveBeenCalledWith(
    "pending-exports/test/backup.wfbackup",
    "backup.wfbackup",
  );
});

it("cleans a cancelled native export without opening the save picker", async () => {
  let finish!: (output: unknown) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const result = exportDatabaseBackup("selected.db", null, true, controller.signal);
  controller.abort();
  finish({ relativePath: "pending-exports/test/backup.db", filename: "backup.db" });
  expect(await result).toBe(false);
  expect(mocks.cleanup).toHaveBeenCalledWith("pending-exports/test");
  expect(mocks.save).not.toHaveBeenCalled();
});

it("stages mobile portable imports and preserves the exact password", async () => {
  mocks.appDataDir.mockResolvedValue("/app");
  const preview = { id: "validated", summary: {} };
  mocks.invoke
    .mockResolvedValueOnce({ os: "android", is_mobile: true })
    .mockResolvedValueOnce(preview);
  expect(await inspectDatabaseBackup("content://backup", "  secret words  ")).toEqual(preview);
  expect(mocks.invoke).toHaveBeenLastCalledWith("inspect_database_backup", {
    backupFilePath: "/app/pending-restores/test/restore.db",
    password: "  secret words  ",
  });
  expect(mocks.cleanup).toHaveBeenCalledWith("pending-restores/test");
});

it("discards a preview if inspection finishes after cancellation", async () => {
  const controller = new AbortController();
  mocks.invoke.mockResolvedValueOnce({ os: "macos" }).mockImplementationOnce(async () => {
    controller.abort();
    return { id: "cancelled", summary: {} };
  });
  expect(
    await inspectDatabaseBackup("/backup.wfbackup", "backup password", controller.signal),
  ).toBeNull();
  expect(mocks.invoke).toHaveBeenLastCalledWith("discard_database_backup_import", {
    id: "cancelled",
  });
});

it("inspects a managed snapshot by identifier and discards cancelled results", async () => {
  const controller = new AbortController();
  mocks.invoke.mockImplementationOnce(async () => {
    controller.abort();
    return { id: "late" };
  });
  expect(await inspectSavedDatabaseBackup("saved.db", controller.signal)).toBeNull();
  expect(mocks.invoke).toHaveBeenNthCalledWith(1, "inspect_saved_database_backup", {
    filename: "saved.db",
  });
  expect(mocks.invoke).toHaveBeenNthCalledWith(2, "discard_database_backup_import", { id: "late" });
});
it("confirms the immutable native import ID", async () => {
  await restoreDatabaseBackupImport("validated");
  expect(mocks.invoke).toHaveBeenCalledWith("restore_database_backup_import", { id: "validated" });
});
