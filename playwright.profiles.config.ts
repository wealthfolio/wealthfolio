import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

// A whole disposable installation: no developer databases, profiles, or .env.
const installation = mkdtempSync(join(tmpdir(), "wealthfolio-profile-e2e-"));
const baseURL = "http://127.0.0.1:18388";
export default defineConfig({
  testDir: "./e2e/profiles",
  workers: 1,
  timeout: 60000,
  reporter: "list",
  outputDir: "/tmp/wealthfolio-profile-e2e-results",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command: resolve("target/debug/wealthfolio-server"),
    cwd: installation,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      WF_LISTEN_ADDR: "127.0.0.1:18388",
      WF_DB_PATH: join(installation, "app.db"),
      WF_DATA_DIR: installation,
      WF_STATIC_DIR: process.env.WF_PROFILE_STATIC_DIR || resolve("dist"),
      WF_SECRET_KEY: randomBytes(32).toString("base64"),
      WF_DB_REQUIRE_ENCRYPTION: "false",
      WF_AUTH_PASSWORD_HASH: "",
      WF_AUTH_REQUIRED: "false",
      WF_MCP_ENABLED: "false",
      RUST_LOG: "warn",
    },
  },
});
