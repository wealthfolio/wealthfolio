import { defineConfig, devices } from "@playwright/test";

// UI guardrails, run on demand rather than in CI. Record a baseline from the code
// before a change, then compare on the same machine; baselines stay in .local/.
export default defineConfig({
  testDir: "./e2e/design-system",
  outputDir: ".local/design-system/results",
  snapshotPathTemplate: ".local/design-system/baselines/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  // WebKit occasionally stalls a page load late in a long run without sending a
  // request. A fresh browser passes it; the report lists such a test as flaky.
  // A real difference fails the retry too.
  retries: 1,
  reporter: "list",
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css", maxDiffPixels: 0 },
  },
  use: {
    baseURL: "http://127.0.0.1:4176",
    trace: "retain-on-failure",
    navigationTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "pnpm --filter frontend exec vite --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176/e2e/design-system/",
    reuseExistingServer: true,
  },
});
