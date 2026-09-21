import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { profileCommand, PROFILE_STATE_TIMEOUT_MS } from "./api";

const broadcast = vi.hoisted(() => {
  const postMessage = vi.fn();
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage = postMessage;
    },
  );
  return postMessage;
});
beforeEach(() => broadcast.mockClear());

vi.mock("@/adapters", () => ({ isWeb: true }));
vi.mock("./session", () => ({ profileScope: () => "scope" }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["get_profile_state", "lock_profile"])("bounds a hanging %s request", async (command) => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options: RequestInit) => {
      signal = options.signal!;
      // Fetch rejects when its signal is aborted, including while offline/hung.
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }),
  );
  const result = expect(profileCommand(command)).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(PROFILE_STATE_TIMEOUT_MS - 1);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the deadline until the response body finishes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      }),
    ),
  );
  const result = expect(profileCommand("get_profile_state")).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.advanceTimersByTimeAsync(PROFILE_STATE_TIMEOUT_MS);
  await result;
});

it("clears the deadline after success and does not time out password work", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("null"));
  vi.stubGlobal("fetch", fetch);
  await profileCommand("get_profile_state");
  expect(vi.getTimerCount()).toBe(0);
  fetch.mockResolvedValue(new Response("null"));
  await profileCommand("unlock_profile");
  expect(fetch.mock.lastCall?.[1]?.signal).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  "unlock_profile",
  "lock_profile",
  "create_profile",
  "delete_profile",
  "update_profile",
  "set_profile_password",
  "recover_profile_password",
])("announces successful %s to other tabs", async (command) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null")));
  await profileCommand(command);
  expect(broadcast).toHaveBeenCalledExactlyOnceWith("changed");
});

it.each(["get_profile_state", "profile_activity", "profile_auth_storage"])(
  "does not announce %s",
  async (command) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null")));
    await profileCommand(command);
    expect(broadcast).not.toHaveBeenCalled();
  },
);

it("does not announce failed mutations", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("PROFILE_LOCKED", { status: 423 })),
  );
  await expect(profileCommand("unlock_profile")).rejects.toThrow("PROFILE_LOCKED");
  expect(broadcast).not.toHaveBeenCalled();
});
