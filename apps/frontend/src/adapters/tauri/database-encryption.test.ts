import { beforeEach, afterEach, expect, it, vi } from "vitest";

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

// Adapter tests exercise transport behavior inside an admitted profile.
beforeEach(async () => {
  const { installProfileSession } = await import("@/features/profiles/session");
  installProfileSession({ profileId: "test-profile", scopeId: "test-scope" });
});

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

it("propagates a sanitized native conversion failure", async () => {
  native.invoke.mockRejectedValue(new Error("FAKE-KEY-2531 /private/portfolio.db"));
  const error = await setDatabaseEncryptionEnabled(true).catch((cause: unknown) => cause);
  expect(error).toHaveProperty("errorCode", "internal_error");
  expect(String(error)).not.toContain("FAKE-KEY");
  expect(String(error)).not.toContain("/private");
});
