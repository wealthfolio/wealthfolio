import { describe, expect, it } from "vitest";
import { classifyAddonErrorHint } from "./addon-iframe-manager";

describe("classifyAddonErrorHint", () => {
  it("classifies opaque-origin Web Storage failures as a storage hint", () => {
    const securityError =
      "SecurityError: Failed to read the 'localStorage' property from 'Window': " +
      "The document is sandboxed and lacks the 'allow-same-origin' flag.";
    expect(classifyAddonErrorHint(securityError)).toContain("storage API");

    expect(classifyAddonErrorHint("Uncaught SecurityError accessing sessionStorage")).toContain(
      "storage API",
    );

    // WKWebView (Tauri macOS) shape — no storage keyword in the message.
    expect(classifyAddonErrorHint("SecurityError: The operation is insecure.")).toContain(
      "storage API",
    );
  });

  it("does NOT classify a non-storage SecurityError as a storage problem", () => {
    // Cross-origin frame access also throws SecurityError — must not be
    // mislabelled as "use the storage API".
    expect(
      classifyAddonErrorHint(
        'SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.',
      ),
    ).toBeUndefined();
  });

  it("classifies unknown host API calls as a version-mismatch hint", () => {
    expect(classifyAddonErrorHint("Unknown addon host API method 'foo.bar'")).toContain(
      "Update the add-on",
    );
  });

  it("classifies an unavailable route (route-id mismatch) as an update hint", () => {
    expect(classifyAddonErrorHint("Addon route 'dashboard' is not available")).toContain(
      "may need updating",
    );
  });

  it("returns undefined for unrecognized or empty errors", () => {
    expect(classifyAddonErrorHint(undefined)).toBeUndefined();
    expect(classifyAddonErrorHint("")).toBeUndefined();
    expect(classifyAddonErrorHint("TypeError: cannot read property 'x' of null")).toBeUndefined();
  });
});
