import { expect, test } from "@playwright/test";

test("keeps stable host error codes on rejected sandbox API calls", async ({ baseURL, page }) => {
  const url = new URL("/__addon-secret-errors__", baseURL).toString();
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw=' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; font-src 'self' data: blob:; frame-src 'none'"><main>Secret errors</main>`,
    }),
  );
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const addonId = "secret-errors";
    const channel = "wealthfolio:addon-sandbox:v1";
    const nonce = crypto.randomUUID();
    const [script, stylesheet, html] = await Promise.all([
      fetch("/__generated__/addon-sandbox-runtime.js").then((response) => response.blob()),
      fetch("/__generated__/addon-sandbox-runtime.css").then((response) => response.blob()),
      fetch("/addon-sandbox.html").then((response) => response.text()),
    ]);
    return new Promise<unknown[]>((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.name = new URLSearchParams({
        addonId,
        channel,
        nonce,
        hostBaseUrl: new URL("/", location.href).toString(),
      }).toString();
      iframe.srcdoc = html;
      const timer = setTimeout(() => reject(new Error("Secret error probe timed out")), 15000);
      const post = (type: string, payload: Record<string, unknown> = {}) =>
        iframe.contentWindow?.postMessage({ addonId, channel, nonce, type, ...payload }, "*");
      const codes = ["SECRET_TOO_LARGE", "SECRET_STORE_UNAVAILABLE", undefined];
      let request = 0;
      window.addEventListener("message", function receive(event) {
        const message = event.data;
        if (event.source !== iframe.contentWindow || message?.addonId !== addonId) return;
        if (message.type === "bootstrapReady") {
          post("loadRuntime", { protocolVersion: 1, script, stylesheet });
        } else if (message.type === "ready") {
          post("loadAddon", {
            code: `export async function enable(ctx) {
            const errors = [];
            for (let i = 0; i < 3; i++) {
              try { await ctx.api.secrets.set('dummy', 'x'); }
              catch (error) { errors.push({ isError: error instanceof Error,
                code: error.code ?? null, message: error.message }); }
            }
            const init = new URLSearchParams(window.name);
            parent.postMessage({ addonId: init.get('addonId'),
              channel: '${channel}', nonce: init.get('nonce'), type: 'secretErrors', errors }, '*');
          }`,
          });
        } else if (message.type === "api") {
          post("rpcResponse", {
            requestId: message.requestId,
            ok: false,
            error: "Message traduit",
            errorCode: codes[request++],
          });
        } else if (message.type === "secretErrors") {
          clearTimeout(timer);
          window.removeEventListener("message", receive);
          resolve(message.errors);
        } else if (message.type === "loadError") {
          clearTimeout(timer);
          reject(new Error(message.error));
        }
      });
      document.body.appendChild(iframe);
    });
  });
  expect(result).toEqual([
    { isError: true, code: "SECRET_TOO_LARGE", message: "Message traduit" },
    { isError: true, code: "SECRET_STORE_UNAVAILABLE", message: "Message traduit" },
    { isError: true, code: null, message: "Message traduit" },
  ]);
});
