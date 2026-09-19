// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertApplicationScriptsAllowed } from "../../scripts/verify-addon-sandbox-runtime.mjs";

const hash = (body) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
const script = '\n document.documentElement.classList.add("dark");\n';

describe("built application CSP contract", () => {
  it("accepts exact inline hashes and ignores external scripts and data blocks", () => {
    const html = `<script>${script}</script><script src="/assets/main.js"></script>
      <script type="application/json">{"data":true}</script><!-- <script>ignored()</script> -->`;
    expect(() =>
      assertApplicationScriptsAllowed(html, `script-src 'self' ${hash(script)}`),
    ).not.toThrow();
  });

  it("rejects the pre-fix policy and reports the required hash", () => {
    expect(() =>
      assertApplicationScriptsAllowed(`<script>${script}</script>`, "script-src 'self'"),
    ).toThrow(hash(script));
  });

  it("detects whitespace changes and additional inline scripts", () => {
    for (const html of [
      `<script>${script} </script>`,
      `<script>${script}</script><script type="module">run()</script>`,
    ]) {
      expect(() => assertApplicationScriptsAllowed(html, `script-src ${hash(script)}`)).toThrow(
        "missing",
      );
    }
  });

  it("checks effective directives and additional HTML policies", () => {
    expect(() =>
      assertApplicationScriptsAllowed(`<script>${script}</script>`, `default-src ${hash(script)}`),
    ).not.toThrow();
    expect(() =>
      assertApplicationScriptsAllowed(
        `<script>${script}</script>`,
        `script-src ${hash(script)}; script-src-elem 'self'`,
      ),
    ).toThrow("missing");
    expect(() =>
      assertApplicationScriptsAllowed(
        `<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><script>${script}</script>`,
        `script-src ${hash(script)}`,
      ),
    ).toThrow("missing");
    expect(() =>
      assertApplicationScriptsAllowed(
        `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'"><script>${script}</script>`,
        `script-src ${hash(script)}`,
      ),
    ).not.toThrow();
  });

  it("requires a hash policy on the server", () => {
    expect(() => assertApplicationScriptsAllowed(`<script>${script}</script>`, "")).toThrow(
      "missing",
    );
  });

  it("does not accept unsafe-inline as a substitute for a hash", () => {
    expect(() =>
      assertApplicationScriptsAllowed(`<script>${script}</script>`, "script-src 'unsafe-inline'"),
    ).toThrow("missing");
  });
});
