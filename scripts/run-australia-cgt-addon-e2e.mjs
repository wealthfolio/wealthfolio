import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { prepE2eEnv } from "./prep-e2e.mjs";

const FRONTEND_URL = "http://localhost:1420";
const BACKEND_URL = "http://localhost:8088";
const ADDON_URL = "http://localhost:3001";
const TEST_SERVER_ENV = {
  WF_LISTEN_ADDR: "127.0.0.1:8088",
  WF_CORS_ALLOW_ORIGINS: FRONTEND_URL,
  WF_SECRET_KEY: randomBytes(32).toString("base64"),
  WF_AUTH_REQUIRED: "false",
  VITE_API_TARGET: BACKEND_URL,
};

const ensureEnvFile = async () => {
  try {
    await access(".env.web");
  } catch (_error) {
    await copyFile(".env.web.example", ".env.web");
  }
};

const requireCommand = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
};

const waitForServer = async (url, processes, { timeout = 120_000, interval = 500 } = {}) => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const process of processes) {
      if (process.startupError) {
        throw process.startupError;
      }
      if (process.exitCode !== null) {
        throw new Error(`Process exited prematurely with code ${process.exitCode}`);
      }
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_error) {
      // Wait until service responds.
    }

    await setTimeout(interval);
  }

  throw new Error(`Timed out waiting for ${url}`);
};

const spawnCommand = (command, args, env = {}) =>
  Object.assign(
    spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    }),
    { startupError: null },
  );

const spawnChecked = (command, args, env = {}) => {
  const child = spawnCommand(command, args, env);
  child.once("error", (error) => {
    child.startupError = error;
  });
  return child;
};

const spawnTestProcess = (command, args, env = {}) =>
  spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

const run = async () => {
  requireCommand("cargo", ["--version"]);
  await ensureEnvFile();
  await prepE2eEnv();

  const addonServer = spawnChecked("pnpm", ["--filter", "australia-cgt-addon", "dev:server"]);
  const backendServer = spawnChecked(
    "cargo",
    ["run", "--manifest-path", "apps/server/Cargo.toml"],
    TEST_SERVER_ENV,
  );
  const frontendServer = spawnChecked("pnpm", ["--filter", "frontend", "dev"], {
    ...TEST_SERVER_ENV,
    BUILD_TARGET: "web",
    WF_ENABLE_VITE_PROXY: "true",
    VITE_ENABLE_ADDON_DEV_MODE: "true",
  });
  const children = [addonServer, backendServer, frontendServer];

  const cleanup = async () => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGINT");
      }
    }
    await Promise.all(children.map((child) => once(child, "exit").catch(() => {})));
  };

  process.once("SIGINT", () => cleanup().catch(() => {}));
  process.once("SIGTERM", () => cleanup().catch(() => {}));

  try {
    await waitForServer(`${ADDON_URL}/health`, children, { timeout: 90_000 });
    await waitForServer(FRONTEND_URL, children, { timeout: 120_000 });
    await waitForServer(`${BACKEND_URL}/api/v1/healthz`, children, {
      timeout: 180_000,
      interval: 1000,
    });

    const tests = spawnTestProcess(
      "pnpm",
      ["exec", "playwright", "test", "e2e/14-australia-cgt-addon.spec.ts"],
      {
        WF_E2E_ENABLE_AUSTRALIA_CGT_ADDON: "true",
      },
    );
    await once(tests, "exit").then(([code]) => {
      if (code !== 0) {
        throw new Error(`Playwright exited with code ${code}`);
      }
    });
  } finally {
    await cleanup();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
