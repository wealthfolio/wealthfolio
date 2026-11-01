import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { toBase64 } from "./core";

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
