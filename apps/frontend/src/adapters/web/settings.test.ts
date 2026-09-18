import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "@/lib/auth-token";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("./core", () => ({
  API_PREFIX: "/api/v1",
  invoke: mocks.invoke,
  logger: mocks.logger,
}));

import {
  exportDatabaseBackup,
  getSettings,
  inspectDatabaseBackup,
  inspectSavedDatabaseBackup,
  restoreDatabaseBackupImport,
  discardDatabaseBackupImport,
} from "./settings";

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([401, 500])(
  "notifies the auth gate only for an unauthorized export: %s",
  async (status) => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status,
        ok: false,
        json: () => Promise.resolve({ message: "Export rejected" }),
      }),
    );

    await expect(exportDatabaseBackup("backup.db", null, true)).rejects.toThrow("Export rejected");
    expect(handler).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  },
);

it("downloads through a browser link without buffering the backup into a Blob", async () => {
  const blob = vi.fn();
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: "job-id", filename: "backup.db" }),
    blob,
  });
  vi.stubGlobal("fetch", fetch);
  let target = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    target = this.href;
  });
  expect(await exportDatabaseBackup("selected.db", null, true)).toBe(true);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toContain("/backups/selected.db/export");
  expect(options.credentials).toBe("same-origin");
  expect(options.headers["X-Wealthfolio-Backup"]).toBe("1");
  expect(JSON.parse(options.body)).toEqual({ password: null, unencrypted: true });
  expect(target).toContain("/utilities/database/exports/job-id");
  expect(blob).not.toHaveBeenCalled();
});

describe("web getSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates backend failures", async () => {
    const error = new Error("Backend unavailable");
    mocks.invoke.mockRejectedValue(error);

    await expect(getSettings()).rejects.toThrow("Backend unavailable");
    expect(mocks.logger.error).toHaveBeenCalledWith("Error fetching settings.");
  });
});

it("rejects every restore entry point without making a server request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(inspectDatabaseBackup(new File(["backup"], "backup.db"), null)).rejects.toThrow();
  await expect(inspectSavedDatabaseBackup("backup.db")).rejects.toThrow();
  await expect(restoreDatabaseBackupImport("preview-id")).rejects.toThrow();
  await expect(discardDatabaseBackupImport("preview-id")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
