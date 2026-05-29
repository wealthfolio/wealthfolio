import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  saveAppDataFileViaPicker: vi.fn(),
}));

vi.mock("./core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("./files", () => ({
  saveAppDataFileViaPicker: mocks.saveAppDataFileViaPicker,
}));

import { exportDataFile } from "./exports";

describe("tauri exportDataFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves backend-created pending exports through the picker", async () => {
    mocks.invoke.mockResolvedValue({
      status: "pending",
      relativePath: "pending-exports/export-id/accounts.csv",
      filename: "accounts.csv",
    });
    mocks.saveAppDataFileViaPicker.mockResolvedValue(true);

    const result = await exportDataFile("CSV", "accounts");

    expect(mocks.invoke).toHaveBeenCalledWith("export_data_file", {
      dataType: "accounts",
      format: "CSV",
    });
    expect(mocks.saveAppDataFileViaPicker).toHaveBeenCalledWith(
      "pending-exports/export-id/accounts.csv",
      "accounts.csv",
    );
    expect(result).toEqual({ status: "saved", filename: "accounts.csv" });
  });

  it("treats picker cancellation as a canceled export", async () => {
    mocks.invoke.mockResolvedValue({
      status: "pending",
      relativePath: "pending-exports/export-id/accounts.csv",
      filename: "accounts.csv",
    });
    mocks.saveAppDataFileViaPicker.mockResolvedValue(false);

    await expect(exportDataFile("CSV", "accounts")).resolves.toEqual({ status: "canceled" });
  });
});
