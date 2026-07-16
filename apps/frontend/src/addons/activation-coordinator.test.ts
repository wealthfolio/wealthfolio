import { beforeEach, describe, expect, it, vi } from "vitest";

// The real iframe manager pulls in the Tauri log plugin (unavailable under
// vitest, produces unhandled rejections). Mock it down to just the one method
// the coordinator consumes.
const hasRuntime = vi.fn<(addonId: string) => boolean>();
vi.mock("@/addons/iframe/addon-iframe-manager", () => ({
  addonIframeManager: {
    hasRuntime: (addonId: string) => hasRuntime(addonId),
  },
}));

import {
  activateView,
  clearActivatable,
  getActivationEpoch,
  getPublishedActivationEpoch,
  invalidateActivations,
  isActivationEpochCurrent,
  isPinned,
  publishActivationEpoch,
  registerActivatable,
  resetActivations,
  subscribeToActivationEpoch,
} from "./activation-coordinator";

/** A boot function whose resolution can be controlled by the test. */
function deferredBoot() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  const fn = vi.fn(() => promise);
  return { fn, resolve };
}

describe("activation coordinator", () => {
  beforeEach(() => {
    hasRuntime.mockReset();
    hasRuntime.mockReturnValue(false);
    resetActivations();
  });

  it("dedupes concurrent activations onto a single boot", async () => {
    const boot = deferredBoot();
    registerActivatable("a", boot.fn, { pinned: false });

    const calls = [activateView("a"), activateView("a"), activateView("a")];
    expect(boot.fn).toHaveBeenCalledTimes(1);

    boot.resolve(true);
    const results = await Promise.all(calls);
    expect(results).toEqual([true, true, true]);
    expect(boot.fn).toHaveBeenCalledTimes(1);
  });

  it("boots again on a subsequent activation once the first has settled", async () => {
    const first = deferredBoot();
    registerActivatable("a", first.fn, { pinned: false });

    const p1 = activateView("a");
    first.resolve(true);
    await p1;

    // Runtime still reported as absent (no eviction), so a fresh activation
    // triggers a new boot rather than reusing the settled in-flight entry.
    const second = deferredBoot();
    registerActivatable("a", second.fn, { pinned: false });
    const p2 = activateView("a");
    second.resolve(true);
    await p2;

    expect(first.fn).toHaveBeenCalledTimes(1);
    expect(second.fn).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale boot erase or replace the current generation", async () => {
    const oldBoot = deferredBoot();
    registerActivatable("a", oldBoot.fn, { pinned: false });
    const oldActivation = activateView("a");

    resetActivations();
    const currentBoot = deferredBoot();
    registerActivatable("a", currentBoot.fn, { pinned: false });
    const currentActivation = activateView("a");

    oldBoot.resolve(false);
    await Promise.resolve();
    await Promise.resolve();

    // The stale promise follows the current generation, and its `finally`
    // must not delete the current in-flight entry. A third caller still joins
    // the one current boot.
    const concurrentActivation = activateView("a");
    expect(currentBoot.fn).toHaveBeenCalledTimes(1);

    currentBoot.resolve(true);
    await expect(
      Promise.all([oldActivation, currentActivation, concurrentActivation]),
    ).resolves.toEqual([true, true, true]);
  });

  it("keeps the reload epoch in memory and notifies only when re-registration is published", async () => {
    let capturedEpoch = -1;
    registerActivatable(
      "a",
      vi.fn((epoch: number) => {
        capturedEpoch = epoch;
        return Promise.resolve(true);
      }),
      { pinned: false },
    );
    await activateView("a");
    expect(isActivationEpochCurrent(capturedEpoch)).toBe(true);

    const listener = vi.fn();
    const unsubscribe = subscribeToActivationEpoch(listener);
    const publishedEpoch = getPublishedActivationEpoch();
    invalidateActivations();
    expect(isActivationEpochCurrent(capturedEpoch)).toBe(false);
    expect(getPublishedActivationEpoch()).toBe(publishedEpoch);
    expect(listener).not.toHaveBeenCalled();

    const invalidatedEpoch = getActivationEpoch();
    resetActivations();
    expect(getActivationEpoch()).toBeGreaterThan(invalidatedEpoch);
    expect(listener).not.toHaveBeenCalled();

    publishActivationEpoch();
    expect(getPublishedActivationEpoch()).toBe(getActivationEpoch());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("returns true immediately when the runtime already exists, without booting", async () => {
    const boot = deferredBoot();
    registerActivatable("a", boot.fn, { pinned: false });
    hasRuntime.mockReturnValue(true);

    await expect(activateView("a")).resolves.toBe(true);
    expect(boot.fn).not.toHaveBeenCalled();
  });

  it("returns false when no boot function is registered", async () => {
    await expect(activateView("missing")).resolves.toBe(false);
  });

  it("tracks pinned addons", () => {
    registerActivatable(
      "pinned",
      vi.fn(async () => true),
      { pinned: true },
    );
    registerActivatable(
      "lazy",
      vi.fn(async () => true),
      { pinned: false },
    );

    expect(isPinned("pinned")).toBe(true);
    expect(isPinned("lazy")).toBe(false);
    expect(isPinned("unknown")).toBe(false);
  });

  it("re-registering an addon can flip its pinned state", () => {
    registerActivatable(
      "a",
      vi.fn(async () => true),
      { pinned: true },
    );
    expect(isPinned("a")).toBe(true);
    registerActivatable(
      "a",
      vi.fn(async () => true),
      { pinned: false },
    );
    expect(isPinned("a")).toBe(false);
  });

  it("clearActivatable forgets a single addon", async () => {
    registerActivatable(
      "a",
      vi.fn(async () => true),
      { pinned: true },
    );
    clearActivatable("a");
    expect(isPinned("a")).toBe(false);
    await expect(activateView("a")).resolves.toBe(false);
  });

  it("resetActivations clears all state", async () => {
    registerActivatable(
      "a",
      vi.fn(async () => true),
      { pinned: true },
    );
    registerActivatable(
      "b",
      vi.fn(async () => true),
      { pinned: false },
    );

    resetActivations();

    expect(isPinned("a")).toBe(false);
    expect(isPinned("b")).toBe(false);
    await expect(activateView("a")).resolves.toBe(false);
    await expect(activateView("b")).resolves.toBe(false);
  });
});
