import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
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
import { invoke } from "./core";
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("lets manual capture finish after the ordinary five-minute deadline", async () => {
  vi.useFakeTimers();
  let complete!: (value: string) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const result = invoke<string>("cloud_backup_capture");
  let finished = false;
  result.then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(finished).toBe(false);
  complete("saved");
  await expect(result).resolves.toBe("saved");
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves the ordinary deadline for unrelated commands", async () => {
  vi.useFakeTimers();
  mocks.invoke.mockImplementation(() => new Promise(() => {}));
  const result = invoke("get_accounts");
  const assertion = expect(result).rejects.toThrow('Command "get_accounts" timed out');
  await vi.advanceTimersByTimeAsync(300_001);
  await assertion;
});
