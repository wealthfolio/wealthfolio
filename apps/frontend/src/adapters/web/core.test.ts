import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, toBase64 } from "./core";
import { installProfileSession } from "@/features/profiles/session";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["BACKUP_REAUTHENTICATION_REQUIRED", "BACKUP_MANUAL_LIMIT"])(
  "keeps the reviewed backup code from HTTP without diagnostic text (%s)",
  async (errorCode) => {
    installProfileSession({ profileId: "test", scopeId: "scope-test" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 400,
            errorCode,
            message: "FAKE-KEY-2531 /private/portfolio.db",
          }),
          { status: 400 },
        ),
      ),
    );
    const error = await invoke("cloud_backup_capture").catch((cause: unknown) => cause);
    expect(error).toHaveProperty("errorCode", errorCode);
    expect(error).toHaveProperty("outcomeUnknown", false);
    expect(String(error)).not.toContain("FAKE-KEY");
    expect(JSON.stringify(error)).not.toContain("/private");
  },
);

it.each(["internal_error", "future_error", undefined])(
  "does not log or throw raw HTTP error messages (%s) and preserves outcomeUnknown",
  async (errorCode) => {
    installProfileSession({ profileId: "test", scopeId: "scope-test" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () =>
          Promise.resolve({
            code: 500,
            errorCode,
            message: "FAKE-KEY-2531 /private/portfolio.db",
          }),
      }),
    );
    const error = await invoke("get_settings").catch((error: unknown) => error);
    expect(error).toHaveProperty("errorCode", "internal_error");
    expect(error).toHaveProperty("outcomeUnknown", true);
    expect(String(error)).not.toContain("FAKE-KEY");
    expect(JSON.stringify(log.mock.calls)).not.toContain("FAKE-KEY");
  },
);

describe("toBase64", () => {
  it.each([0, 1, 2, 3, 256, 32767, 32768, 32769, 65535, 65536, 65537])(
    "encodes %i bytes with correct padding across chunk boundaries",
    (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      const expected = Buffer.from(bytes).toString("base64");

      expect(toBase64(bytes)).toBe(expected);
      expect(toBase64(Array.from(bytes))).toBe(expected);
    },
  );

  it("encodes only the bytes within an offset view", () => {
    const bytes = Uint8Array.from({ length: 65545 }, (_, index) => index % 256);
    const view = bytes.subarray(3, bytes.length - 5);

    expect(toBase64(view)).toBe(Buffer.from(view).toString("base64"));
  });

  it("encodes a large input without exceeding function argument limits", () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 + 1 }, (_, index) => index % 256);

    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
