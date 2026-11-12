import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tauriInvoke: vi.fn() }));
vi.mock("./core", () => ({ invoke: mocks.tauriInvoke, tauriInvoke: mocks.tauriInvoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ BaseDirectory: {}, open: vi.fn() }));

import { extractAddonZip, installAddonZip } from "./addons";

// Large enough to cross the encoder's 32 KiB chunks, with a view that does not
// start at the buffer's first byte.
const zip = new Uint8Array(100_003).map((_, index) => (index * 31) & 0xff).subarray(3);
const zipDataB64 = Buffer.from(zip).toString("base64");

beforeEach(() => {
  mocks.tauriInvoke.mockReset();
  mocks.tauriInvoke.mockResolvedValue({});
});

describe("add-on zip commands", () => {
  it("sends the zip to extract_addon_zip as base64", async () => {
    await extractAddonZip(zip);

    expect(mocks.tauriInvoke).toHaveBeenCalledWith("extract_addon_zip", { zipDataB64 });
  });

  it("sends the zip and install options to install_addon_zip", async () => {
    await installAddonZip(zip, false, ["api.example.com"]);

    expect(mocks.tauriInvoke).toHaveBeenCalledWith("install_addon_zip", {
      zipDataB64,
      enableAfterInstall: false,
      approvedNetworkHosts: ["api.example.com"],
    });
  });
});
