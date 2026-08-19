import { createBaseConfig } from "../../eslint.base.config.js";

export default [
  // Ignores for frontend
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "*.config.d.ts",
      "coverage/**",
      "public/**",
      "**/*.d.ts",
      "**/recharts/**",
      "**/react-qr-code/**",
      "src/lib/recharts-patch.ts",
      "src/lib/react-qr-code-patch.ts",
    ],
  },

  // Use base config for frontend app
  ...createBaseConfig({
    includeReact: true,
    includeTanstackQuery: true,
    includeReactRefresh: true,
    tsconfigPath: ["./tsconfig.json", "./tsconfig.node.json"],
  }),

  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/utils.ts", "src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/utils",
              importNames: [
                "formatAmount",
                "formatCompactAmount",
                "formatPercent",
                "formatQuantity",
                "getGlobalFormatting",
              ],
              message: "Use @wealthfolio/ui formatting hooks or semantic display components.",
            },
          ],
        },
      ],
    },
  },
];
