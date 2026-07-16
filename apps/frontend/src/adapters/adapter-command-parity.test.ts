import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMMANDS, invoke } from "./web/core";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const frontendSrcDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(currentDir, "../../../..");

const INVOKE_COMMAND_RE = /invoke(?:<[^>]+>)?\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g;
const TAURI_REGISTERED_COMMAND_RE = /commands::[a-z_]+::([a-zA-Z0-9_]+)/g;
const RUNTIME_EXPORT_RE =
  /^export\s+(?:const|async\s+function|function|class|enum)\s+([a-zA-Z_$][\w$]*)/gm;
const NAMED_REEXPORT_RE = /export\s*\{([^{}]*)\}\s*from\s*["']([^"']+)["']/g;

afterEach(() => {
  vi.unstubAllGlobals();
});

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [entryPath] : [];
  });
}

/**
 * Collect all `features/*\/adapters/*.ts` files. Feature-local adapters call
 * `invoke(...)` and must round-trip through both the Tauri command registry
 * and the web COMMANDS dispatch.
 */
function collectFeatureAdapterFiles(): string[] {
  const featuresDir = path.join(frontendSrcDir, "features");
  const featureEntries = readdirSync(featuresDir, { withFileTypes: true });
  return featureEntries.flatMap((feature) => {
    if (!feature.isDirectory()) return [];
    const adaptersDir = path.join(featuresDir, feature.name, "adapters");
    try {
      return collectSourceFiles(adaptersDir);
    } catch {
      return [];
    }
  });
}

function collectInvokedCommands(files: string[]): Map<string, string[]> {
  const commands = new Map<string, string[]>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(INVOKE_COMMAND_RE)) {
      const command = match[1];
      const relativePath = path.relative(repoRoot, file);
      const existingFiles = commands.get(command) ?? [];
      if (!existingFiles.includes(relativePath)) {
        existingFiles.push(relativePath);
      }
      commands.set(command, existingFiles);
    }
  }

  return commands;
}

function collectRegisteredTauriCommands(): Set<string> {
  const source = readFileSync(path.join(repoRoot, "apps/tauri/src/lib.rs"), "utf8");
  return new Set([...source.matchAll(TAURI_REGISTERED_COMMAND_RE)].map((match) => match[1]));
}

function collectRuntimeExports(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  return new Set([...source.matchAll(RUNTIME_EXPORT_RE)].map((match) => match[1]));
}

function collectNamedReexports(
  file: string,
  modulePath: string,
): { hasStar: boolean; names: Set<string> } {
  const source = readFileSync(file, "utf8");
  const names = new Set<string>();
  let hasStar = false;

  for (const match of source.matchAll(NAMED_REEXPORT_RE)) {
    if (match[2] !== modulePath) continue;

    for (const rawName of match[1].split(",")) {
      const name = rawName
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
  }

  if (
    source.includes(`export * from "${modulePath}"`) ||
    source.includes(`export * from '${modulePath}'`)
  ) {
    hasStar = true;
  }

  return { hasStar, names };
}

describe("adapter command parity", () => {
  it("registers every command reachable from the web adapter", () => {
    const files = [
      ...collectSourceFiles(path.join(frontendSrcDir, "adapters/shared")),
      ...collectSourceFiles(path.join(frontendSrcDir, "adapters/web")),
      ...collectFeatureAdapterFiles(),
    ];
    const invokedCommands = collectInvokedCommands(files);

    const missing = [...invokedCommands.entries()]
      .filter(([command]) => COMMANDS[command] === undefined)
      .map(([command, files]) => `${command}: ${files.join(", ")}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it("registers every command reachable from the Tauri adapter", () => {
    const files = [
      ...collectSourceFiles(path.join(frontendSrcDir, "adapters/shared")),
      ...collectSourceFiles(path.join(frontendSrcDir, "adapters/tauri")),
      ...collectFeatureAdapterFiles(),
    ];
    const invokedCommands = collectInvokedCommands(files);
    const registeredCommands = collectRegisteredTauriCommands();

    const missing = [...invokedCommands.entries()]
      .filter(([command]) => !registeredCommands.has(command))
      .map(([command, files]) => `${command}: ${files.join(", ")}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it("re-exports shared runtime commands from the web adapter barrel", () => {
    const sharedDir = path.join(frontendSrcDir, "adapters/shared");
    const webIndexFile = path.join(frontendSrcDir, "adapters/web/index.ts");
    const missing = readdirSync(sharedDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "platform.ts",
      )
      .flatMap((entry) => {
        const moduleName = entry.name.replace(/\.ts$/, "");
        const sharedExports = collectRuntimeExports(path.join(sharedDir, entry.name));
        const webReexports = collectNamedReexports(webIndexFile, `../shared/${moduleName}`);

        if (webReexports.hasStar) return [];

        return [...sharedExports]
          .filter((name) => !webReexports.names.has(name))
          .map((name) => `${moduleName}.${name}`);
      })
      .sort();

    expect(missing).toEqual([]);
  });

  it("routes allocation drilldown requests with all required filters", async () => {
    const response = new Response(JSON.stringify({ holdings: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await invoke("get_holdings_by_allocation", {
      filter: { type: "all" },
      taxonomyId: "asset_classes",
      categoryId: "EQUITY",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/allocations/holdings/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      filter: { type: "all" },
      taxonomyId: "asset_classes",
      categoryId: "EQUITY",
    });
  });
});

// ─── Scope routing coverage ───────────────────────────────────────────────────

function stubFetch(body: unknown = []) {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const mock = vi.fn<typeof fetch>().mockResolvedValue(res);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function lastCall(mock: ReturnType<typeof stubFetch>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, method: (init as RequestInit & { method: string }).method, body: init.body };
}

describe("scope-based routing — get_holdings", () => {
  it("all → POST /holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings", { filter: { type: "all" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({ filter: { type: "all" } });
  });

  it("account → GET /holdings?accountId=...", async () => {
    const mock = stubFetch();
    await invoke("get_holdings", { filter: { type: "account", accountId: "acc_1" } });
    const { url, method } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings?accountId=acc_1");
    expect(method).toBe("GET");
  });

  it("portfolio → POST /holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings", { filter: { type: "portfolio", portfolioId: "pf_1" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "portfolio", portfolioId: "pf_1" },
    });
  });

  it("accounts → POST /holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings", {
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
  });
});

describe("scope-based routing — get_holdings_list", () => {
  it("all → POST /holdings/list/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_list", { filter: { type: "all" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/list/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({ filter: { type: "all" } });
  });

  it("account → GET /holdings/list?accountId=...", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_list", { filter: { type: "account", accountId: "acc_1" } });
    const { url, method } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/list?accountId=acc_1");
    expect(method).toBe("GET");
  });

  it("portfolio → POST /holdings/list/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_list", { filter: { type: "portfolio", portfolioId: "pf_1" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/list/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "portfolio", portfolioId: "pf_1" },
    });
  });

  it("accounts → POST /holdings/list/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_list", {
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/holdings/list/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
  });
});

describe("scope-based routing — get_portfolio_allocations", () => {
  it("all → POST /allocations/query", async () => {
    const mock = stubFetch();
    await invoke("get_portfolio_allocations", { filter: { type: "all" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({ filter: { type: "all" } });
  });

  it("account → GET /allocations?accountId=...", async () => {
    const mock = stubFetch();
    await invoke("get_portfolio_allocations", {
      filter: { type: "account", accountId: "acc_1" },
    });
    const { url, method } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations?accountId=acc_1");
    expect(method).toBe("GET");
  });

  it("portfolio → POST /allocations/query", async () => {
    const mock = stubFetch();
    await invoke("get_portfolio_allocations", {
      filter: { type: "portfolio", portfolioId: "pf_1" },
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "portfolio", portfolioId: "pf_1" },
    });
  });

  it("accounts → POST /allocations/query", async () => {
    const mock = stubFetch();
    await invoke("get_portfolio_allocations", {
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
  });
});

describe("scope-based routing — get_holdings_by_allocation", () => {
  const drilldown = { taxonomyId: "asset_classes", categoryId: "EQUITY" };

  it("all → POST /allocations/holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_by_allocation", { filter: { type: "all" }, ...drilldown });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({ filter: { type: "all" }, ...drilldown });
  });

  it("account → GET /allocations/holdings?...", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_by_allocation", {
      filter: { type: "account", accountId: "acc_1" },
      ...drilldown,
    });
    const { url, method } = lastCall(mock);
    expect(url).toBe(
      "/api/v1/allocations/holdings?accountId=acc_1&taxonomyId=asset_classes&categoryId=EQUITY",
    );
    expect(method).toBe("GET");
  });

  it("portfolio → POST /allocations/holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_by_allocation", {
      filter: { type: "portfolio", portfolioId: "pf_1" },
      ...drilldown,
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "portfolio", portfolioId: "pf_1" },
      ...drilldown,
    });
  });

  it("accounts → POST /allocations/holdings/query", async () => {
    const mock = stubFetch();
    await invoke("get_holdings_by_allocation", {
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
      ...drilldown,
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/allocations/holdings/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
      ...drilldown,
    });
  });
});

describe("scope-based routing — get_income_summary", () => {
  it("all → POST /income/summary/query", async () => {
    const mock = stubFetch();
    await invoke("get_income_summary", { filter: { type: "all" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/income/summary/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({ filter: { type: "all" } });
  });

  it("account → GET /income/summary?accountId=...", async () => {
    const mock = stubFetch();
    await invoke("get_income_summary", { filter: { type: "account", accountId: "acc_1" } });
    const { url, method } = lastCall(mock);
    expect(url).toBe("/api/v1/income/summary?accountId=acc_1");
    expect(method).toBe("GET");
  });

  it("portfolio → POST /income/summary/query", async () => {
    const mock = stubFetch();
    await invoke("get_income_summary", { filter: { type: "portfolio", portfolioId: "pf_1" } });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/income/summary/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "portfolio", portfolioId: "pf_1" },
    });
  });

  it("accounts → POST /income/summary/query", async () => {
    const mock = stubFetch();
    await invoke("get_income_summary", {
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/income/summary/query");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] },
    });
  });
});

describe("scope-based routing — performance filters", () => {
  const commands = [
    { command: "calculate_performance_history", path: "/api/v1/performance/history" },
    { command: "calculate_performance_summary", path: "/api/v1/performance/summary" },
  ] as const;
  const scopes = [
    { name: "all", filter: { type: "all" } },
    { name: "portfolio", filter: { type: "portfolio", portfolioId: "pf_1" } },
    { name: "accounts", filter: { type: "accounts", accountIds: ["acc_1", "acc_2"] } },
  ] as const;

  for (const { command, path } of commands) {
    for (const { name, filter } of scopes) {
      it(`${command} sends ${name} filter`, async () => {
        const mock = stubFetch();
        await invoke(command, {
          itemType: "account",
          itemId: "portfolio:all",
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          trackingMode: "TRANSACTIONS",
          filter,
        });

        const { url, method, body } = lastCall(mock);
        expect(url).toBe(path);
        expect(method).toBe("POST");
        expect(JSON.parse(body as string)).toEqual({
          itemType: "account",
          itemId: "portfolio:all",
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          trackingMode: "TRANSACTIONS",
          filter,
        });
      });
    }
  }

  it("get_performance_summaries sends batch scopes", async () => {
    const mock = stubFetch();
    await invoke("get_performance_summaries", {
      scopes: [{ accountIds: ["acc_2", "acc_1"] }],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      profile: "summary",
    });

    const { url, method, body } = lastCall(mock);
    expect(url).toBe("/api/v1/performance/summaries");
    expect(method).toBe("POST");
    expect(JSON.parse(body as string)).toEqual({
      scopes: [{ accountIds: ["acc_2", "acc_1"] }],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      profile: "summary",
    });
  });
});
