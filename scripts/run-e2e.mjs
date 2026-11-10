import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stopServer } from "./e2e-server.mjs";
import { prepE2eEnv } from "./prep-e2e.mjs";

const DEV_SERVER_URL = process.env.WF_E2E_BASE_URL || "http://localhost:1420";
const BACKEND_URL = process.env.WF_E2E_BACKEND_URL || "http://localhost:8088";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUOTE_FIXTURE_DIR = join(REPO_ROOT, "e2e", "fixtures", "quotes");
const DEFAULT_RUST_LOG = ["error", "wealthfolio_core::quotes::sync=warn"].join(",");
const cliArgs = process.argv.slice(2);
const shouldUseUi = cliArgs.includes("--ui");

const buildHealthUrl = (base, path = "/") =>
  new URL(path, `${base.replace(/\/$/, "")}/`).toString();

export const waitForServer = async (
  url,
  serverProcess,
  { path = "/", timeout = 60_000, interval = 500 } = {},
) => {
  const deadline = Date.now() + timeout;
  const healthUrl = buildHealthUrl(url, path);

  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Dev server exited prematurely with code ${serverProcess.exitCode}`);
    }

    try {
      const response = await fetch(healthUrl, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch (error) {
      // continue until service responds
    }

    await setTimeout(interval);
  }

  throw new Error(`Timed out waiting for ${healthUrl}`);
};

// `/` needs a web build in dist/; the health route answers without one.
export const waitForBackend = (url, serverProcess, options = {}) =>
  waitForServer(url, serverProcess, {
    path: "/api/v1/healthz",
    timeout: 120_000,
    interval: 1000,
    ...options,
  });

const spawnCommand = (command, args, extraEnv = {}) =>
  spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });

const devServerPort = (() => {
  try {
    return new URL(DEV_SERVER_URL).port || "1420";
  } catch {
    return "1420";
  }
})();

const runPlaywrightTests = (extraArgs = []) =>
  new Promise((resolve, reject) => {
    const tests = spawnCommand("pnpm", ["exec", "playwright", "test", ...extraArgs]);
    tests.once("error", reject);
    tests.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Playwright exited with code ${code}`));
      }
    });
  });

const run = async () => {
  await prepE2eEnv();

  const devServer = spawnCommand("pnpm", ["run", "dev:web"], {
    WEALTHFOLIO_E2E: "1",
    WEALTHFOLIO_FIXTURE_DIR: QUOTE_FIXTURE_DIR,
    WEALTHFOLIO_FIXTURE_AS_OF: process.env.WEALTHFOLIO_FIXTURE_AS_OF || "2026-05-12",
    // dev:web keeps a shell value over .env.web; the agent access specs need MCP on.
    WF_MCP_ENABLED: "true",
    RUST_LOG: process.env.WF_E2E_RUST_LOG || DEFAULT_RUST_LOG,
    VITE_DEV_PORT: devServerPort,
  });

  const cleanup = () => stopServer(devServer, "SIGINT");

  const handleSignal = () => {
    cleanup().catch(() => {});
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  process.once("exit", handleSignal);

  try {
    // Wait for both frontend and backend to be ready
    console.log("Waiting for frontend server...");
    await waitForServer(DEV_SERVER_URL, devServer);
    console.log("Frontend ready. Waiting for backend server...");
    await waitForBackend(BACKEND_URL, devServer);
    console.log("Backend ready. Starting tests...");
    await runPlaywrightTests(cliArgs);
  } finally {
    await cleanup();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
