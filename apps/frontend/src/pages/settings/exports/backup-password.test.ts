import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBackupPassword, isValidBackupPassword } from "./backup-password";

afterEach(() => vi.restoreAllMocks());
describe("backup passwords", () => {
  it("counts Unicode scalar characters, preserves spaces and bounds UTF-8 size", () => {
    expect(isValidBackupPassword("🦊".repeat(11))).toBe(false);
    expect(isValidBackupPassword("🦊".repeat(12))).toBe(true);
    expect(isValidBackupPassword("🦊".repeat(1024))).toBe(true);
    expect(isValidBackupPassword("a".repeat(1025))).toBe(false);
    expect(isValidBackupPassword("  twelve words ")).toBe(true);
  });
  it("uses secure randomness and rejects biased tail samples", () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    const samples = [255, limit, 0, alphabet.length - 1, ...Array<number>(22).fill(1)];
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array)[0] = samples.shift()!;
      return array;
    });
    expect(generateBackupPassword()).toBe(`A9${"B".repeat(22)}`);
    expect(samples).toHaveLength(0);
  });
  it("creates valid 24-character passwords without ambiguous characters", () => {
    for (let index = 0; index < 32; index++) {
      const password = generateBackupPassword();
      expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{24}$/);
      expect(isValidBackupPassword(password)).toBe(true);
    }
  });
});
