import { beforeEach, describe, expect, it, vi } from "vitest";
describe("profile request authority", () => {
  beforeEach(() => vi.resetModules());
  it("does not allow an old async operation to acquire a new scope", async () => {
    const session = await import("./session");
    expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
    session.installProfileSession({ profileId: "a", scopeId: "scope-a" });
    expect(session.profileScope()).toBe("scope-a");
    session.revokeProfileSession();
    expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
  });
  it("keeps the profile admitted during temporary Connect contention", async () => {
    const session = await import("./session");
    const grant = { profileId: "a", scopeId: "scope-a" };
    session.installProfileSession(grant);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("Connect account change in progress", { status: 503 }))
        .mockResolvedValueOnce(new Response("portfolio"))
        .mockResolvedValueOnce(new Response("Profile locked", { status: 423 })),
    );
    try {
      expect((await session.profileFetch("/api/v1/accounts")).status).toBe(503);
      expect(session.installProfileSession(grant)).toBe(true);
      expect(session.profileScope()).toBe("scope-a");
      expect(await (await session.profileFetch("/api/v1/accounts")).text()).toBe("portfolio");
      await expect(session.profileFetch("/api/v1/accounts")).rejects.toThrow("PROFILE_LOCKED");
      expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("preserves the grant and diagnostic response when runtime startup fails", async () => {
    const session = await import("./session");
    session.installProfileSession({ profileId: "a", scopeId: "scope-a" });
    const diagnostic = "PROFILE_STARTUP_FAILED: Missing internal instance ID";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(diagnostic, { status: 500 })));
    try {
      const response = await session.profileFetch("/api/v1/accounts");
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(diagnostic);
      expect(session.profileScope()).toBe("scope-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("discards a response that arrives after lock", async () => {
    const session = await import("./session");
    session.installProfileSession({ profileId: "a", scopeId: "scope-a" });
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const response = session.profileFetch("/api/v1/accounts");
    session.revokeProfileSession();
    release(new Response("private"));
    await expect(response).rejects.toThrow("PROFILE_LOCKED");
    vi.unstubAllGlobals();
  });
});

it("does not reload for a stale status response during pending native auth", async () => {
  vi.resetModules();
  const session = await import("./session");
  session.installProfileSession({ profileId: "a", scopeId: "scope-a" });
  session.deferProfileReload(true);
  session.revokeProfileSession();
  expect(session.installProfileSession({ profileId: "a", scopeId: "scope-a" })).toBe(false);
  expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
});

it("reloads for a fresh recovery grant even after revocation, without admitting it in the old document", async () => {
  vi.resetModules();
  const reload = vi.fn();
  vi.doMock("@/lib/reload-application", () => ({
    reloadApplication: reload,
    deferApplicationReload: vi.fn(),
  }));
  const session = await import("./session");
  session.installProfileSession({ profileId: "a", scopeId: "old" });
  session.revokeProfileSession();
  expect(session.installProfileSession({ profileId: "a", scopeId: "new" })).toBe(false);
  expect(reload).toHaveBeenCalledWith({ dashboard: false });
  expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
  vi.doUnmock("@/lib/reload-application");
});
it("routes cross-tab profile changes to the dashboard", async () => {
  vi.resetModules();
  const reload = vi.fn();
  vi.doMock("@/lib/reload-application", () => ({
    reloadApplication: reload,
    deferApplicationReload: vi.fn(),
  }));
  const session = await import("./session");
  session.installProfileSession({ profileId: "a", scopeId: "old" });
  expect(session.installProfileSession({ profileId: "b", scopeId: "new" })).toBe(false);
  expect(reload).toHaveBeenCalledWith({ dashboard: true });
  expect(() => session.profileScope()).toThrow("PROFILE_LOCKED");
  vi.doUnmock("@/lib/reload-application");
});

it("enables legacy preference fallback only with backend legacy metadata", async () => {
  vi.resetModules();
  const session = await import("./session");
  expect(session.usesLegacyPreferences()).toBe(false);
  const grant = { profileId: "adopted", scopeId: "scope" };
  session.installProfileSession(grant, true);
  expect(session.usesLegacyPreferences()).toBe(true);
});
