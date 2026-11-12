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
import { invoke, tauriInvoke } from "./core";
import { error as logError } from "@tauri-apps/plugin-log";
vi.mock("../shared/platform", () => import("./core"));
import { resetProviderHistory } from "../shared/market-data";
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

it("does not log or rethrow private desktop provider error messages", async () => {
  mocks.invoke.mockRejectedValue({
    errorCode: "provider_unavailable",
    message: "FAKE-KEY-2531 /private/portfolio.db",
  });
  const error = await invoke("list_ai_models", { providerId: "google" }).catch(
    (error: unknown) => error,
  );
  expect(error).toHaveProperty("errorCode", "provider_unavailable");
  expect(String(error)).not.toContain("FAKE-KEY");
  expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain("FAKE-KEY");
});

it("discards legacy raw IPC errors while preserving code-only loan refusals", async () => {
  mocks.invoke.mockRejectedValueOnce("FAKE-KEY-2531 /private/portfolio.db");
  const failure = await invoke("get_settings").catch((error: unknown) => error);
  expect(failure).toHaveProperty("errorCode", "internal_error");
  expect(String(failure)).not.toContain("FAKE-KEY");
  mocks.invoke.mockRejectedValueOnce("LOAN_EVENT_CHANGED");
  await expect(invoke("apply_loan_action")).rejects.toThrow("LOAN_EVENT_CHANGED");
});

it("normalizes errors for direct IPC calls too", async () => {
  mocks.invoke.mockRejectedValueOnce({
    ServiceError: { errorCode: "internal_error", message: "FAKE-KEY-2531" },
  });
  const failure = await tauriInvoke("stream_ai_chat").catch((error: unknown) => error);
  expect(failure).toHaveProperty("errorCode", "internal_error");
  expect(String(failure)).not.toContain("FAKE-KEY");
});

it.each(["BACKUP_REAUTHENTICATION_REQUIRED", "BACKUP_MANUAL_LIMIT"])(
  "keeps the backup recovery code across desktop IPC (%s)",
  async (code) => {
    mocks.invoke.mockRejectedValueOnce(
      `API error (409): ${code}: FAKE-KEY-2531 /private/portfolio.db`,
    );
    const failure = await invoke("cloud_backup_capture").catch((cause: unknown) => cause);
    expect(failure).toHaveProperty("errorCode", code);
    expect(String(failure)).not.toContain("FAKE-KEY");
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain("/private");
  },
);

it.each(["SUBSCRIPTION_REQUIRED", "PLAN_UPGRADE_REQUIRED", "RATE_LIMITED"])(
  "keeps the Connect code the desktop command sends (%s)",
  async (code) => {
    mocks.invoke.mockRejectedValueOnce(code);
    const failure = await invoke("get_user_info").catch((cause: unknown) => cause);
    expect(failure).toHaveProperty("errorCode", code);
  },
);

it("does not trust transport Error objects as public messages", async () => {
  mocks.invoke.mockRejectedValue(new Error("FAKE-KEY-2531 /private/portfolio.db"));
  const failure = await tauriInvoke("get_settings").catch((error: unknown) => error);
  expect(failure).toHaveProperty("errorCode", "internal_error");
  expect(String(failure)).not.toContain("FAKE-KEY");
});

it.each([false, true, undefined, "false"])(
  "preserves the desktop history reset outcome through both adapters (%s)",
  async (outcomeUnknown) => {
    mocks.invoke.mockRejectedValueOnce({
      message: "FAKE-KEY-2531 /private/portfolio.db",
      outcomeUnknown,
      privateDetail: "account_balance",
    });
    const failure = await resetProviderHistory("asset").catch((error: unknown) => error);
    expect(failure).toHaveProperty(
      "outcomeUnknown",
      typeof outcomeUnknown === "boolean" ? outcomeUnknown : true,
    );
    expect(String(failure)).not.toContain("FAKE-KEY");
    expect(JSON.stringify(failure)).not.toContain("account_balance");
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain("/private");
  },
);
