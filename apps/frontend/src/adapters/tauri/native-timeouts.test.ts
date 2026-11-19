import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/features/profiles/session", () => ({
  profileScope: () => "profile",
  revokeProfileSession: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: "AppData" },
  open: vi.fn(),
  startAccessingSecurityScopedResource: vi.fn(),
  stopAccessingSecurityScopedResource: vi.fn(),
}));

import { openFileSaveDialog } from "./files";
import { exportDataFile } from "./exports";
import { installUpdate } from "./settings";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each(["ios", "android"])(
  "expires %s export preparation before opening the picker",
  async (os) => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation((command) =>
      command === "get_platform" ? Promise.resolve({ os, is_mobile: true }) : new Promise(() => {}),
    );
    const result = exportDataFile("CSV", "accounts");
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["text", "binary", "data"])(
  "lets a desktop %s save dialog remain open beyond command deadlines",
  async (kind) => {
    vi.useFakeTimers();
    let complete!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command) =>
      command === "get_platform"
        ? Promise.resolve({ os: "macos", is_mobile: false })
        : new Promise((resolve) => {
            complete = resolve;
          }),
    );
    let settled = false;
    const operation =
      kind === "data"
        ? exportDataFile("CSV", "accounts")
        : openFileSaveDialog(kind === "text" ? "contents" : new Uint8Array([1, 2]), "report.csv");
    const result = operation.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(settled).toBe(false);
    complete(kind === "data" ? { status: "saved", filename: "report.csv" } : true);
    await expect(result).resolves.toEqual(
      kind === "data" ? { status: "saved", filename: "report.csv" } : true,
    );
    const call = mocks.invoke.mock.calls.find(([command]) => command !== "get_platform");
    expect(call?.[1]).toMatchObject({ scopeId: "profile" });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("lets update installation finish after the routine and heavy deadlines", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  let settled = false;
  const result = installUpdate().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(30 * 60_000 + 15_000);
  expect(settled).toBe(false);
  complete();
  await expect(result).resolves.toBeUndefined();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["ios", "android"])(
  "keeps %s export preparation bounded, with the picker outside its deadline",
  async (os) => {
    vi.useFakeTimers();
    let prepare!: (value: unknown) => void;
    let pick!: (value: null) => void;
    mocks.invoke.mockImplementation((command) => {
      if (command === "get_platform") return Promise.resolve({ os, is_mobile: true });
      if (command === "profile_transfer_file") return Promise.resolve();
      return new Promise((resolve) => {
        prepare = resolve;
      });
    });
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          pick = resolve;
        }),
    );
    let settled = false;
    const result = exportDataFile("CSV", "accounts").then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(299_999);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    prepare({
      status: "pending",
      relativePath: "pending-exports/id/accounts.csv",
      filename: "accounts.csv",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    pick(null);
    await expect(result).resolves.toEqual({ status: "canceled" });
  },
);
