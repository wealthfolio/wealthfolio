import { createBaseConfig } from "./eslint.base.config.js";

export default [
  // Global ignores for root workspace
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "apps/tauri/**",
      "apps/server/**",
      "apps/frontend/**",
      "*.config.js",
      "*.config.ts",
      "*.config.d.ts",
      "coverage/**",
      "**/*.d.ts",
      "**/recharts/**",
      "**/react-qr-code/**",
      // Local data and embedded addon bundles
      "db/**",
      // Let package workspaces handle their own linting
      "packages/**",
      // Test and build artifacts
      "playwright-report/**",
      "test-results/**",
      "scripts/**",
      "e2e/**",
      "target/**",
    ],
  },

  // Use base config for any root-level JS/TS files
  ...createBaseConfig({
    includeReact: false,
    includeTanstackQuery: false,
    includeReactRefresh: false,
    tsconfigPath: ["./tsconfig.json"],
  }),
];
