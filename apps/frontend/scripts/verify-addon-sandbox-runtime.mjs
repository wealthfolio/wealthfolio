import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import { JSDOM } from "jsdom";

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = path.join(FRONTEND_ROOT, "public", "__generated__");
const SANDBOX_HTML = path.join(FRONTEND_ROOT, "addon-sandbox.html");
const INDEX_HTML = path.join(FRONTEND_ROOT, "index.html");
const TAURI_CONFIG = path.resolve(FRONTEND_ROOT, "..", "tauri", "tauri.conf.json");
const SERVER_API = path.resolve(FRONTEND_ROOT, "..", "server", "src", "api.rs");
const EXPECTED_FILES = ["addon-sandbox-runtime.css", "addon-sandbox-runtime.js"];
const EXPECTED_BOOTSTRAP_HASH = "sha256-s/UhdlprnzFxx+iXOtDj2n/Jk+MSRz1g/1lyBtFatVw=";
const EXPECTED_SANDBOX_CSP = `default-src 'none'; script-src '${EXPECTED_BOOTSTRAP_HASH}' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

function parseCsp(policy, label) {
  const directives = new Map();
  for (const serializedDirective of policy.split(";")) {
    const tokens = serializedDirective.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [rawName, ...sources] = tokens;
    const name = rawName.toLowerCase();
    if (directives.has(name)) {
      throw new Error(`${label} contains duplicate ${name} directives`);
    }
    directives.set(name, sources);
  }
  return directives;
}

function extractMetaCsps(html) {
  const policies = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const httpEquiv = tag.match(/\bhttp-equiv\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (httpEquiv?.toLowerCase() !== "content-security-policy") continue;
    const content = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (content) policies.push(content);
  }
  return policies;
}

function extractRustStringConstant(source, name) {
  const match = source.match(new RegExp(`const ${name}: &str = "([^"]+)";`));
  if (!match) {
    throw new Error(`Could not find Rust string constant ${name}`);
  }
  return match[1];
}

function assertExactCsp(actualPolicy, expectedPolicy, label) {
  const actual = parseCsp(actualPolicy, label);
  const expected = parseCsp(expectedPolicy, "expected sandbox CSP");
  if (
    actual.size !== expected.size ||
    Array.from(expected).some(
      ([name, sources]) => JSON.stringify(actual.get(name)) !== JSON.stringify(sources),
    )
  ) {
    throw new Error(`${label} does not match the required network-free policy`);
  }
}

function assertEmbedderAllowsSandboxRuntime(policy, label) {
  const directives = parseCsp(policy, label);
  const scriptSources = directives.get("script-src") ?? [];
  const styleSources = directives.get("style-src") ?? [];
  const fontSources = directives.get("font-src") ?? [];
  const mediaSources = directives.get("media-src") ?? [];
  if (
    JSON.stringify(directives.get("frame-src")) !== JSON.stringify(["'none'"]) ||
    !scriptSources.includes(`'${EXPECTED_BOOTSTRAP_HASH}'`) ||
    !scriptSources.includes("'wasm-unsafe-eval'") ||
    !scriptSources.includes("blob:") ||
    !styleSources.includes("blob:") ||
    !fontSources.includes("blob:") ||
    !mediaSources.includes("blob:")
  ) {
    throw new Error(`${label} must block frame navigation and allow the hashed Blob runtime`);
  }
}

// Require explicit hashes for application inline code, even if a policy is loosened.
export function assertApplicationScriptsAllowed(html, policy) {
  const document = new JSDOM(html).window.document;
  const policies = [policy, ...extractMetaCsps(html)].map((value) =>
    parseCsp(value, "Application CSP"),
  );
  for (const script of document.querySelectorAll("script:not([src])")) {
    const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
    if (
      type &&
      !["module", "importmap", "speculationrules"].includes(type) &&
      !/^(text|application)\/(x-)?(java|ecma)script$/.test(type) &&
      !/^text\/(javascript1\.[0-5]|jscript|livescript)$/.test(type)
    ) {
      continue; // Data blocks such as application/json are not executable scripts.
    }
    const body = script.textContent;
    if (!body.trim()) continue;
    const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
    for (const [index, directives] of policies.entries()) {
      const sources =
        directives.get("script-src-elem") ??
        directives.get("script-src") ??
        directives.get("default-src");
      if ((sources || index === 0) && !sources?.includes(`'${hash}'`)) {
        throw new Error(
          `Application inline script is missing '${hash}' from its CSP. ` +
            "Update the policy to match the built index.html; do not enable unsafe-inline.",
        );
      }
    }
  }
}

export async function verifyAddonSandboxRuntime({ dist = false, web = false } = {}) {
  const artifactDirectory = dist
    ? path.resolve(FRONTEND_ROOT, "..", "..", "dist", "__generated__")
    : GENERATED_DIR;
  const sandboxHtml = dist
    ? path.resolve(FRONTEND_ROOT, "..", "..", "dist", "addon-sandbox.html")
    : SANDBOX_HTML;
  const indexHtml = dist
    ? path.resolve(FRONTEND_ROOT, "..", "..", "dist", "index.html")
    : INDEX_HTML;
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const actualFiles = entries.map((entry) => entry.name).sort();
  if (
    actualFiles.length !== EXPECTED_FILES.length ||
    actualFiles.some((name, index) => name !== EXPECTED_FILES[index]) ||
    entries.some((entry) => !entry.isFile())
  ) {
    throw new Error(
      `Sandbox runtime must emit only ${EXPECTED_FILES.join(", ")}; received ${actualFiles.join(", ")}`,
    );
  }

  const jsPath = path.join(artifactDirectory, "addon-sandbox-runtime.js");
  const cssPath = path.join(artifactDirectory, "addon-sandbox-runtime.css");
  const [javascript, css, html, embedderHtml, tauriConfigJson, serverApi, jsStats, cssStats] =
    await Promise.all([
      readFile(jsPath, "utf8"),
      readFile(cssPath, "utf8"),
      readFile(sandboxHtml, "utf8"),
      readFile(indexHtml, "utf8"),
      readFile(TAURI_CONFIG, "utf8"),
      readFile(SERVER_API, "utf8"),
      stat(jsPath),
      stat(cssPath),
    ]);

  await init;
  const [imports] = parse(javascript);
  const externalImports = imports.filter(
    (entry) => entry.d === -1 || (entry.d >= 0 && entry.n !== undefined),
  );
  if (externalImports.length > 0) {
    throw new Error("Sandbox runtime JavaScript contains a static or literal external import");
  }

  for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const url = match[2].trim();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) {
      throw new Error(`Sandbox runtime CSS contains an external URL: ${url}`);
    }
  }

  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\brel=["']stylesheet["']/i.test(html)) {
    throw new Error("Sandbox HTML must not contain external scripts or stylesheets");
  }
  const inlineScripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi));
  if (inlineScripts.length !== 1) {
    throw new Error("Sandbox HTML must contain exactly one inline bootstrap script");
  }
  const bootstrapHash = `sha256-${createHash("sha256").update(inlineScripts[0][1]).digest("base64")}`;
  if (bootstrapHash !== EXPECTED_BOOTSTRAP_HASH) {
    throw new Error(`Sandbox bootstrap hash changed; received ${bootstrapHash}`);
  }
  const sandboxPolicies = extractMetaCsps(html);
  if (sandboxPolicies.length !== 1) {
    throw new Error("Sandbox HTML must contain exactly one Content-Security-Policy meta tag");
  }
  assertExactCsp(sandboxPolicies[0], EXPECTED_SANDBOX_CSP, "Sandbox HTML CSP");

  const embedderPolicies = extractMetaCsps(embedderHtml).map((policy) =>
    parseCsp(policy, "Application HTML CSP"),
  );
  if (
    !embedderPolicies.some(
      (policy) => JSON.stringify(policy.get("frame-src")) === JSON.stringify(["'none'"]),
    )
  ) {
    throw new Error("Application HTML CSP must contain frame-src 'none'");
  }
  if (web) {
    assertApplicationScriptsAllowed(
      embedderHtml,
      extractRustStringConstant(serverApi, "SERVER_CSP"),
    );
  }
  const tauriSecurity = JSON.parse(tauriConfigJson).app?.security;
  assertEmbedderAllowsSandboxRuntime(tauriSecurity?.csp ?? "", "Tauri CSP");
  assertEmbedderAllowsSandboxRuntime(tauriSecurity?.devCsp ?? "", "Tauri development CSP");
  assertEmbedderAllowsSandboxRuntime(
    extractRustStringConstant(serverApi, "SERVER_CSP"),
    "Axum CSP",
  );
  assertExactCsp(
    extractRustStringConstant(serverApi, "ADDON_SANDBOX_CSP"),
    EXPECTED_SANDBOX_CSP,
    "Axum sandbox CSP",
  );
  if (jsStats.size > 8 * 1024 * 1024) {
    throw new Error(`Sandbox runtime JavaScript exceeds 8 MiB (${jsStats.size} bytes)`);
  }
  if (cssStats.size > 5 * 1024 * 1024) {
    throw new Error(`Sandbox runtime CSS exceeds 5 MiB (${cssStats.size} bytes)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyAddonSandboxRuntime({
    dist: process.argv.includes("--dist"),
    web: process.argv.includes("--web"),
  });
}
