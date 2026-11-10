import assert from "node:assert/strict";
import test from "node:test";
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
