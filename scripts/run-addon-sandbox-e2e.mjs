import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { stopServer } from "./e2e-server.mjs";

const BASE_URL = process.env.WF_ADDON_SANDBOX_BASE_URL || "http://127.0.0.1:4174";

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, { stdio: "inherit", ...options });
}

async function runCommand(command, args) {
  const child = spawnCommand(command, args);
  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

async function waitForPreview(preview) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(`Vite preview exited with code ${preview.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Keep polling until preview is ready.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Vite preview");
}

if (process.env.WF_ADDON_SANDBOX_SKIP_BUILD !== "true") {
  await runCommand("pnpm", ["run", "build:types"]);
  await runCommand("pnpm", ["run", "build"]);
}

const previewUrl = new URL(BASE_URL);
const preview = spawnCommand("pnpm", [
  "--filter",
  "frontend",
  "preview",
  "--host",
  previewUrl.hostname,
  "--port",
  previewUrl.port || "4174",
  "--strictPort",
]);

const stopPreview = () => stopServer(preview, "SIGTERM");

try {
  await waitForPreview(preview);
  await runCommand("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.addon-sandbox.config.ts",
  ]);
} finally {
  await stopPreview();
}
