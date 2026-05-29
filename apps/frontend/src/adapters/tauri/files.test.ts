import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  copyFile: vi.fn(),
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
  copyFile: mocks.copyFile,
  remove: mocks.remove,
  startAccessingSecurityScopedResource: mocks.startAccessingSecurityScopedResource,
  stopAccessingSecurityScopedResource: mocks.stopAccessingSecurityScopedResource,
}));

vi.mock("./core", () => ({
  invoke: mocks.invoke,
}));

import { saveAppDataFileViaPicker } from "./files";

describe("saveAppDataFileViaPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue("/picked/accounts.csv");
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.startAccessingSecurityScopedResource.mockResolvedValue(undefined);
    mocks.stopAccessingSecurityScopedResource.mockResolvedValue(undefined);
  });

  it("copies only pending export files through the iOS security-scoped destination", async () => {
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
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "pending-exports/export-id/accounts.csv",
      "/picked/accounts.csv",
      { fromPathBaseDir: "AppData" },
    );
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
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("cleans the pending file when the picker is canceled", async () => {
    mocks.save.mockResolvedValue(null);

    const saved = await saveAppDataFileViaPicker(
      "pending-exports/export-id/accounts.csv",
      "accounts.csv",
    );

    expect(saved).toBe(false);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id/accounts.csv", {
      baseDir: "AppData",
    });
    expect(mocks.remove).toHaveBeenCalledWith("pending-exports/export-id", {
      baseDir: "AppData",
    });
  });
});
