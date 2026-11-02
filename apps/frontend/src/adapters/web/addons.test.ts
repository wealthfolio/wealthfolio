import { Buffer } from "node:buffer";
import { installProfileSession } from "@/features/profiles/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAddonZip, installAddonZip } from "./addons";
import { invoke } from "./core";

vi.mock("./core", async (importOriginal) => {
  const core = await importOriginal<typeof import("./core")>();
  return { ...core, invoke: vi.fn(core.invoke) };
});

beforeEach(() => {
  vi.clearAllMocks();
  installProfileSession({ profileId: "test", scopeId: "scope-test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("web add-on ZIP uploads", () => {
  it("passes the original byte view through extraction and sends base64 JSON", async () => {
    const fetchMock = stubFetch();
    const bytes = Uint8Array.from({ length: 65545 }, (_, index) => index % 256);
    const zipData = bytes.subarray(3, bytes.length - 5);

    await extractAddonZip(zipData);

    expect(vi.mocked(invoke).mock.calls[0]?.[1]?.zipData).toBe(zipData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/addons/extract");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(options?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-wf-profile-scope")).toBe("scope-test");
    expect(JSON.parse(options?.body as string)).toEqual({
      zipDataB64: Buffer.from(zipData).toString("base64"),
    });
  });

  it.each([undefined, false, true])(
    "passes the original bytes through installation and preserves enableAfterInstall=%s",
    async (enableAfterInstall) => {
      const fetchMock = stubFetch();
      const zipData = Uint8Array.from({ length: 32769 }, (_, index) => index % 256);
      const approvedNetworkHosts = ["api.example.test"];

      await installAddonZip(zipData, enableAfterInstall, approvedNetworkHosts);

      expect(vi.mocked(invoke).mock.calls[0]?.[1]?.zipData).toBe(zipData);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/addons/install-zip");
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(options?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("x-wf-profile-scope")).toBe("scope-test");
      expect(JSON.parse(options?.body as string)).toEqual({
        zipDataB64: Buffer.from(zipData).toString("base64"),
        ...(enableAfterInstall === undefined ? {} : { enableAfterInstall }),
        approvedNetworkHosts,
      });
    },
  );
});
