import { afterEach, expect, it, vi } from "vitest";
import { installProfileSession } from "@/features/profiles/session";
import { invoke } from "./core";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["get_accounts", {}, 60_000],
  ["get_historical_valuations", { filter: { type: "all" } }, 300_000],
  ["preview_import_assets", { candidates: [] }, 600_000],
  ["check_activities_import", { activities: [] }, 600_000],
  ["check_holdings_import", { accountId: "test", snapshots: [] }, 600_000],
  ["import_activities", { activities: [] }, 300_000],
  ["import_holdings_csv", { accountId: "test", snapshots: [] }, 300_000],
  ["cloud_backup_capture", {}, 1_920_000],
] as const)(
  "passes the production deadline to %s and propagates timeout without retry",
  async (command, payload, expected) => {
    installProfileSession({ profileId: "test", scopeId: "scope-test" });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = invoke(command, payload);
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(expected);
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
