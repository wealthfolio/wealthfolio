import tanstackQuery from "@tanstack/eslint-plugin-query";
import react from "eslint-plugin-react";
import tseslint from "typescript-eslint";

// Oxlint owns the shared rules. Keep the original React deprecation check and
// TanStack Query rules here: the latter include no-void-query-fn, which needs
// TypeScript parser services unavailable to Oxlint's JavaScript plugins.
export function createBaseConfig(options = {}) {
  const { includeReact = true, includeTanstackQuery = true } = options;

  return [
    ...(includeReact
      ? [
          {
            files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
            languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
            plugins: { react },
            // "detect" crashes eslint-plugin-react 7.37 on ESLint 10 (it calls
            // the removed context.getFilename). Keep in step with React.
            settings: { react: { version: "19.2" } },
            rules: {
              "react/no-deprecated": "error",
              // Preserve ESLint's handling of TypeScript assertions around optional chains.
              "no-unsafe-optional-chaining": "error",
            },
          },
        ]
      : []),
    ...(includeTanstackQuery
      ? [
          {
            files: ["**/*.{ts,tsx}"],
            languageOptions: {
              parser: tseslint.parser,
              parserOptions: { projectService: true },
            },
            plugins: { "@tanstack/query": tanstackQuery },
            rules: {
              "@tanstack/query/no-rest-destructuring": "warn",
              "@tanstack/query/stable-query-client": "error",
              "@tanstack/query/infinite-query-property-order": "error",
              "@tanstack/query/no-void-query-fn": "error",
              "@tanstack/query/mutation-property-order": "error",
              "@tanstack/query/exhaustive-deps": "warn",
              "@tanstack/query/no-unstable-deps": "warn",
            },
          },
        ]
      : []),
    // React's deprecation rule also needs a parser for TypeScript library files.
    ...(!includeTanstackQuery && includeReact
      ? [{ files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.parser } }]
      : []),
  ];
}
