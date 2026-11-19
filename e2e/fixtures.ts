import { test as base, type BrowserContext } from "@playwright/test";

export * from "@playwright/test";

// The page error boundary catches render crashes and shows "Something went
// wrong" without an uncaught error, so its log line counts as a crash too.
const BOUNDARY_LOG = "Error Boundary Caught Error";

const watched = new WeakSet<BrowserContext>();

function watch(context: BrowserContext, crashes: string[]) {
  if (watched.has(context)) return;
  watched.add(context);
  context.on("weberror", (error) => crashes.push(error.error().message));
  context.on("console", (message) => {
    if (message.type() === "error" && message.text().startsWith(BOUNDARY_LOG)) {
      crashes.push(message.text().split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim());
    }
  });
}

interface CrashLog {
  entries: string[];
  /** How many entries earlier tests on this worker have already checked. */
  checked: number;
}

/**
 * Fails a test when any page it drives crashes: an uncaught error, or a render
 * error the page error boundary caught. Covers the test's own page and pages
 * from `browser.newPage()`/`newContext()`, such as one shared in `beforeAll`.
 * Specs import `test` and `expect` from here instead of `@playwright/test`.
 */
export const test = base.extend<{ crashGuard: void }, { crashLog: CrashLog }>({
  crashLog: [
    async ({ browser }, use) => {
      const log: CrashLog = { entries: [], checked: 0 };
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        watch(context, log.entries);
        return context;
      };
      await use(log);
    },
    // Automatic, so it watches pages that `beforeAll` hooks create before the
    // first test sets up its fixtures.
    { scope: "worker", auto: true },
  ],
  crashGuard: [
    async ({ crashLog }, use, testInfo) => {
      await use();
      // Everything since the previous test's check, so a crash in a `beforeAll`
      // hook, which runs before this fixture, fails the file's first test.
      const crashes = crashLog.entries.slice(crashLog.checked);
      crashLog.checked = crashLog.entries.length;
      if (crashes.length > 0 && testInfo.expectedStatus === "passed") {
        throw new Error(
          `The page crashed during this test or a hook before it:\n- ${crashes.join("\n- ")}`,
        );
      }
    },
    { auto: true },
  ],
});
