import { createBaseConfig } from "../../eslint.base.config.js";

export default [
  { ignores: ["dist/**", "node_modules/**", "*.config.ts", "*.config.js"] },
  ...createBaseConfig({ includeTanstackQuery: false }),
];
