import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  openFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  startAccessingSecurityScopedResource: vi.fn(),
  stopAccessingSecurityScopedResource: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: {
    AppData: "AppData",
  },
  mkdir: mocks.mkdir,
  open: mocks.openFile,
  remove: mocks.remove,
  startAccessingSecurityScopedResource: mocks.startAccessingSecurityScopedResource,
  stopAccessingSecurityScopedResource: mocks.stopAccessingSecurityScopedResource,
}));

vi.mock("./core", () => ({
  invoke: mocks.invoke,
}));

import { saveAppDataFileViaPicker, stagePickedDatabaseFileForRestore } from "./files";

const mockFileCopy = (chunks: Uint8Array[] = [new Uint8Array([1, 2, 3])]) => {
  const source = {
    read: vi
      .fn()
      .mockImplementationOnce(async (buffer: Uint8Array) => {
        buffer.set(chunks[0]);
        return chunks[0].byteLength;
      })
      .mockResolvedValueOnce(null),
    write: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const destination = {
    read: vi.fn(),
    write: vi.fn(async (data: Uint8Array) => data.byteLength),
    close: vi.fn().mockResolvedValue(undefined),
  };

  mocks.openFile.mockResolvedValueOnce(source).mockResolvedValueOnce(destination);
  return { source, destination };
};

describe("saveAppDataFileViaPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue("/picked/accounts.csv");
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.startAccessingSecurityScopedResource.mockResolvedValue(undefined);
    mocks.stopAccessingSecurityScopedResource.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies only pending export files through the mobile save destination", async () => {
    const { destination, source } = mockFileCopy();

    const saved = await saveAppDataFileViaPicker(
      "pending-exports/export-id/accounts.csv",
      "accounts.csv",
    );

    expect(saved).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: "accounts.csv",
      filters: [{ name: "CSV File", extensions: ["csv"] }],
    });
    expect(mocks.startAccessingSecurityScopedResource).toHaveBeenCalledWith("/picked/accounts.csv");
    expect(mocks.openFile).toHaveBeenNthCalledWith(1, "pending-exports/export-id/accounts.csv", {
      read: true,
      baseDir: "AppData",
    });
    expect(mocks.openFile).toHaveBeenNthCalledWith(2, "/picked/accounts.csv", {
      write: true,
      create: true,
      truncate: true,
    });
    expect(destination.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(destination.close).toHaveBeenCalled();
    expect(source.close).toHaveBeenCalled();
    expect(mocks.stopAccessingSecurityScopedResource).toHaveBeenCalledWith("/picked/accounts.csv");
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id/accounts.csv", {
      baseDir: "AppData",
    });
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id", {
      baseDir: "AppData",
    });
  });

  it("rejects paths outside the pending export directory", async () => {
    await expect(saveAppDataFileViaPicker("../accounts.csv", "accounts.csv")).rejects.toThrow(
      "Only pending export files can be saved with the native file picker",
    );

    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("cleans the pending file when the picker is canceled", async () => {
    mocks.save.mockResolvedValue(null);

    const saved = await saveAppDataFileViaPicker(
      "pending-exports/export-id/accounts.csv",
      "accounts.csv",
    );

    expect(saved).toBe(false);
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id/accounts.csv", {
      baseDir: "AppData",
    });
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id", {
      baseDir: "AppData",
    });
  });

  it("stages a picked Android content URI into app data before restore", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "restore-id" });
    const { destination } = mockFileCopy([new Uint8Array([4, 5])]);

    const staged = await stagePickedDatabaseFileForRestore("content://picked/backup.db");

    expect(staged).toEqual({
      relativePath: "pending-restores/restore-id/restore.db",
      pendingDir: "pending-restores/restore-id",
    });
    expect(mocks.mkdir).toHaveBeenCalledWith("pending-restores/restore-id", {
      baseDir: "AppData",
      recursive: true,
    });
    expect(mocks.openFile).toHaveBeenNthCalledWith(1, "content://picked/backup.db", {
      read: true,
    });
    expect(mocks.openFile).toHaveBeenNthCalledWith(2, "pending-restores/restore-id/restore.db", {
      write: true,
      create: true,
      truncate: true,
      baseDir: "AppData",
    });
    expect(destination.write).toHaveBeenCalledWith(new Uint8Array([4, 5]));
  });
});
