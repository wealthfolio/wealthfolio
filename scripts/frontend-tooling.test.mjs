import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = join(root, "apps/frontend");

test("Oxlint preserves typed, package, custom hook, and import restrictions", async (t) => {
  const frontendDir = await mkdtemp(join(frontend, "src/tooling-check-"));
  const sdkDir = await mkdtemp(join(root, "packages/addon-sdk/src/tooling-check-"));
  t.after(() => Promise.all([frontendDir, sdkDir].map((dir) => rm(dir, { recursive: true }))));

  const component = `
    import { useEffectOnChange } from "@/hooks/use-effect-on-change";
    import { formatAmount } from "@/lib/utils";
    export function ToolingProbe({ value }: { value: number }) {
      useEffectOnChange(() => { console.warn(value); }, []);
      return <span>{formatAmount(value)}</span>;
    }
    export async function typedRuleProbe() { await 123; }
  `;
  const source = join(frontendDir, "source.tsx");
  const exemptTest = join(frontendDir, "source.test.tsx");
  const javascript = join(frontendDir, "source.mjs");
  const sdk = join(sdkDir, "source.ts");
  await writeFile(source, component);
  await writeFile(exemptTest, component);
  await writeFile(javascript, "export const platform = process.platform; console.warn(platform);");
  await writeFile(sdk, "export const unsafeValue: any = 1; const unusedValue = 1;");

  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/oxlint/bin/oxlint"),
      "--type-aware",
      "--format",
      "json",
      source,
      exemptTest,
      javascript,
      sdk,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const { diagnostics } = JSON.parse(result.stdout);
  const hasRule = (file, rule, severity) =>
    diagnostics.some(
      (diagnostic) =>
        join(root, diagnostic.filename) === file &&
        diagnostic.code === rule &&
        diagnostic.severity === severity,
    );
  assert.ok(hasRule(source, "typescript(await-thenable)", "error"));
  assert.ok(hasRule(source, "react-hooks(exhaustive-deps)", "warning"));
  assert.ok(hasRule(source, "eslint(no-restricted-imports)", "error"));
  assert.ok(!hasRule(exemptTest, "eslint(no-restricted-imports)", "error"));
  assert.ok(hasRule(sdk, "typescript(no-explicit-any)", "error"));
  assert.ok(hasRule(sdk, "eslint(no-unused-vars)", "error"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.filename.endsWith("source.mjs")));
});

test("ESLint retains typed Query rules, React deprecations, and optional-chain checks", async () => {
  const eslint = new ESLint({ cwd: frontend });
  const [result] = await eslint.lintText(
    `
    import React from "react";
    import { useQuery } from "@tanstack/react-query";
    export function useToolingProbe() {
      return useQuery({ queryKey: ["tooling-probe"], queryFn: async (): Promise<void> => { await Promise.resolve(); } });
    }
    export const Legacy = React.createClass({ render() { return null; } });
    export function unsafeChain(value: { run(): void } | undefined) { (value?.run)(); }
    export function assertedChain(value: { run(): void } | undefined) { (value?.run as () => void)(); }
  `,
    { filePath: "src/hooks/use-accounts.ts" },
  );
  for (const rule of [
    "@tanstack/query/no-void-query-fn",
    "react/no-deprecated",
    "no-unsafe-optional-chaining",
  ]) {
    assert.ok(
      result.messages.some((message) => message.ruleId === rule && message.severity === 2),
      rule,
    );
  }
  assert.equal(
    result.messages.filter((message) => message.ruleId === "no-unsafe-optional-chaining").length,
    1,
  );
});
