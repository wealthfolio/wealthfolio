import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  stage: vi.fn(),
  cleanup: vi.fn(),
  appDataDir: vi.fn(),
  join: vi.fn(),
}));
vi.mock("./core", () => ({ invoke: mocks.invoke, logger: { error: vi.fn() } }));
vi.mock("./files", () => ({
  stagePickedDatabaseFileForRestore: mocks.stage,
  removeAppDataPath: mocks.cleanup,
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: mocks.appDataDir, join: mocks.join }));

import { restoreDatabase } from "./settings";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.stage.mockResolvedValue({
    relativePath: "pending-restores/test/restore.db",
    pendingDir: "pending-restores/test",
  });
  mocks.join.mockImplementation(async (base: string, relative: string) => `${base}/${relative}`);
});

it.each([
  ["ios", "file:///picked/backup.db", "/var/mobile/Application/test/Library/Application Support"],
  ["android", "content://provider/document/backup", "/data/user/0/com.teymz.wealthfolio/files"],
])("restores %s backups using the absolute staged path", async (os, pickedPath, appData) => {
  mocks.invoke.mockResolvedValueOnce({ os, is_mobile: true });
  mocks.appDataDir.mockResolvedValue(appData);

  await restoreDatabase(pickedPath);

  expect(mocks.stage).toHaveBeenCalledWith(pickedPath);
  expect(mocks.join).toHaveBeenCalledWith(appData, "pending-restores/test/restore.db");
  expect(mocks.invoke).toHaveBeenCalledWith("restore_database", {
    backupFilePath: `${appData}/pending-restores/test/restore.db`,
  });
  expect(mocks.cleanup).toHaveBeenCalledWith("pending-restores/test");
});

it("keeps desktop paths unchanged without staging", async () => {
  mocks.invoke.mockResolvedValueOnce({ os: "windows", is_mobile: false });
  await restoreDatabase("C:\\backups\\portfolio.db");
  expect(mocks.invoke).toHaveBeenCalledWith("restore_database", {
    backupFilePath: "C:\\backups\\portfolio.db",
  });
  expect(mocks.stage).not.toHaveBeenCalled();
  expect(mocks.appDataDir).not.toHaveBeenCalled();
  expect(mocks.cleanup).not.toHaveBeenCalled();
});

it("cleans staged files when backend restore fails", async () => {
  mocks.invoke
    .mockResolvedValueOnce({ os: "android" })
    .mockRejectedValueOnce(new Error("Invalid backup"));
  mocks.appDataDir.mockResolvedValue("/app/data");
  await expect(restoreDatabase("content://backup")).rejects.toThrow("Invalid backup");
  expect(mocks.cleanup).toHaveBeenCalledWith("pending-restores/test");
});

it("cleans staged files if resolving AppData fails without invoking restore", async () => {
  mocks.invoke.mockResolvedValueOnce({ os: "ios" });
  mocks.appDataDir.mockRejectedValue(new Error("AppData unavailable"));
  await expect(restoreDatabase("file:///backup.db")).rejects.toThrow("AppData unavailable");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.cleanup).toHaveBeenCalledWith("pending-restores/test");
});
