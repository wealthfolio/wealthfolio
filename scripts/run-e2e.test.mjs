import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { stopServer } from "./e2e-server.mjs";
import { waitForBackend, waitForServer } from "./run-e2e.mjs";

const BACKEND_URL = "http://127.0.0.1:8188";
const runningServer = { exitCode: null };

// A backend without a web build: the API answers, `/` has no index.html.
const withBackendWithoutWebBuild = async (callback) => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return { ok: url === `${BACKEND_URL}/api/v1/healthz` };
  };
  try {
    await callback(requested);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test("the backend counts as ready without a web build", async () => {
  await withBackendWithoutWebBuild(async (requested) => {
    for (const url of [BACKEND_URL, `${BACKEND_URL}/`]) {
      await waitForBackend(url, runningServer, { timeout: 100, interval: 1 });
    }
    assert.deepEqual(requested, [`${BACKEND_URL}/api/v1/healthz`, `${BACKEND_URL}/api/v1/healthz`]);
  });
});

test("a timeout names the URL that was polled", async () => {
  await withBackendWithoutWebBuild(async () => {
    await assert.rejects(waitForServer(BACKEND_URL, runningServer, { timeout: 20, interval: 1 }), {
      message: `Timed out waiting for ${BACKEND_URL}/`,
    });
  });
});

// Like a pnpm that hands off to the pinned version: it waits on its child
// synchronously and doesn't pass a signal on.
const HANDOFF = `
  process.on("SIGINT", () => {});
  require("node:child_process").spawnSync(process.execPath, [
    "-e",
    "console.log(process.pid); setInterval(() => {}, 1000);",
  ], { stdio: "inherit" });
`;

test(
  "stopping a server reaches a child its launcher doesn't signal",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const server = spawn(process.execPath, ["-e", HANDOFF], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let childPid;
    try {
      const [output] = await once(server.stdout, "data", { signal: t.signal });
      childPid = Number(String(output).trim());
      const stopped = await Promise.race([
        stopServer(server, "SIGINT").then(() => true),
        setTimeout(5000, false, { ref: false }),
      ]);
      assert.equal(stopped, true);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      for (const pid of [childPid, server.pid].filter(Boolean)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already stopped
        }
      }
    }
  },
);
