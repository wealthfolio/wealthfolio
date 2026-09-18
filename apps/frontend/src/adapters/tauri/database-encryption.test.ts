import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@tauri-apps/plugin-log", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(), join: vi.fn() }));
vi.mock("./files", () => ({
  removeAppDataPath: vi.fn(),
  saveAppDataFileViaPicker: vi.fn(),
  stagePickedDatabaseFileForRestore: vi.fn(),
}));

import { setDatabaseEncryptionEnabled } from "./settings";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each([true, false])(
  "waits beyond five minutes for native encryption conversion: %s",
  async (enabled) => {
    vi.useFakeTimers();
    let complete!: () => void;
    native.invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    let state = "pending";
    const operation = setDatabaseEncryptionEnabled(enabled).then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );

    await vi.advanceTimersByTimeAsync(300_001);
    const beforeCompletion = state;
    complete();
    await operation;

    expect(beforeCompletion).toBe("pending");
    expect(state).toBe("resolved");
  },
);

it("propagates a native conversion failure", async () => {
  native.invoke.mockRejectedValue(new Error("Database maintenance failed"));
  await expect(setDatabaseEncryptionEnabled(true)).rejects.toThrow("Database maintenance failed");
});
