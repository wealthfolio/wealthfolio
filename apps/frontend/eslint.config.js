import { createBaseConfig } from "../../eslint.base.config.js";

export default [
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
  ...createBaseConfig({ includeTanstackQuery: true }),
];
