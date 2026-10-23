import { fixupPluginRules } from "@eslint/compat";
import js from "@eslint/js";
import tanstackQuery from "@tanstack/eslint-plugin-query";
import prettierConfig from "eslint-config-prettier";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint configuration for all workspaces in the monorepo
 * Each workspace can extend this base config with their own specific rules
 */
export function createBaseConfig(options = {}) {
  const {
    includeReact = true,
    includeTanstackQuery = true,
    includeReactRefresh = true,
    tsconfigPath = "./tsconfig.json",
    additionalIgnores = [],
  } = options;

  return [
    // Base JavaScript config
    js.configs.recommended,

    // TypeScript type-checked configs (only apply to TS files)
    ...tseslint.configs.recommendedTypeChecked.map((config) => ({
      ...config,
      files: ["**/*.{ts,tsx}"],
    })),
    ...tseslint.configs.stylisticTypeChecked.map((config) => ({
      ...config,
      files: ["**/*.{ts,tsx}"],
    })),

    // TypeScript configuration
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        globals: {
          ...globals.browser,
          ...globals.es2020,
          ...globals.node,
        },
        parser: tseslint.parser,
        parserOptions: {
          ecmaFeatures: {
            jsx: true,
          },
          // Use TypeScript Project Service for typed linting in monorepos
          // This avoids issues with project references and speeds up linting.
          projectService: true,
        },
      },
      plugins: {
        "@typescript-eslint": tseslint.plugin,
        ...(includeReact && { react }),
        ...(includeReact && { "react-hooks": fixupPluginRules(reactHooks) }),
        ...(includeReactRefresh && { "react-refresh": reactRefresh }),
        ...(includeTanstackQuery && { "@tanstack/query": tanstackQuery }),
      },
      rules: {
        // TypeScript rules
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
        // Prefer warnings for stylistic suggestions to reduce friction
        "@typescript-eslint/prefer-nullish-coalescing": "off",
        "@typescript-eslint/prefer-optional-chain": "warn",
        "@typescript-eslint/no-unnecessary-type-assertion": "warn",
        "@typescript-eslint/restrict-template-expressions": [
          "warn",
          {
            allowNumber: true,
            allowBoolean: true,
            allowNullish: true,
            allowAny: true,
            allowRegExp: true,
          },
        ],
        "@typescript-eslint/no-empty-function": "warn",
        "@typescript-eslint/consistent-type-definitions": "warn",
        // Relax misuse-of-promises: allow async handlers in JSX and surface as warnings
        "@typescript-eslint/no-misused-promises": [
          "warn",
          {
            // Allow async functions in void-return positions (e.g., React handlers)
            checksVoidReturn: false,
          },
        ],
        "@typescript-eslint/no-explicit-any": "warn",
        "@typescript-eslint/unbound-method": "off",

        // Relaxed rules for better developer experience
        "@typescript-eslint/no-unsafe-assignment": "warn",
        "@typescript-eslint/no-unsafe-member-access": "warn",
        "@typescript-eslint/no-unsafe-call": "warn",
        "@typescript-eslint/no-unsafe-argument": "warn",
        "@typescript-eslint/no-unsafe-return": "warn",
        "@typescript-eslint/no-floating-promises": "off",
        "@typescript-eslint/require-await": "warn",

        // General rules
        "no-empty": ["warn", { allowEmptyCatch: true }],
        "no-prototype-builtins": "warn",
        "no-case-declarations": "warn",
        "no-console": ["warn", { allow: ["warn", "error"] }],
        "prefer-const": "error",
        "no-var": "error",

        // React rules (if enabled)
        ...(includeReact && {
          ...react.configs.recommended.rules,
          ...react.configs["jsx-runtime"].rules,
          ...reactHooks.configs.recommended.rules,
          "react-hooks/rules-of-hooks": "warn",
          // Check the dependencies of hooks that take a list like useEffect's.
          "react-hooks/exhaustive-deps": ["warn", { additionalHooks: "^useEffectOnChange$" }],
          "react/no-unescaped-entities": "warn",
          "react/prop-types": "off",
          "react/react-in-jsx-scope": "off",
          "react/jsx-uses-react": "off",
        }),

        // React Refresh rules (if enabled)
        ...(includeReactRefresh && {
          "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
        }),

        // TanStack Query rules (if enabled)
        ...(includeTanstackQuery && {
          ...tanstackQuery.configs.recommended.rules,
          "@tanstack/query/exhaustive-deps": "warn",
          "@tanstack/query/no-unstable-deps": "warn",
        }),
      },
      settings: {
        ...(includeReact && {
          react: {
            version: "detect",
          },
        }),
      },
    },

    // JavaScript files configuration
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        globals: {
          ...globals.browser,
          ...globals.node,
        },
        parserOptions: {
          ecmaFeatures: {
            jsx: true,
          },
        },
      },
      plugins: {
        ...(includeReact && { react }),
        ...(includeReact && { "react-hooks": fixupPluginRules(reactHooks) }),
      },
      rules: {
        // General rules
        "no-console": ["warn", { allow: ["warn", "error"] }],
        "prefer-const": "error",
        "no-var": "error",

        // React rules (if enabled)
        ...(includeReact && {
          ...react.configs.recommended.rules,
          ...react.configs["jsx-runtime"].rules,
          ...reactHooks.configs.recommended.rules,
          "react/prop-types": "off",
          "react/react-in-jsx-scope": "off",
          "react/jsx-uses-react": "off",
        }),
      },
      settings: {
        ...(includeReact && {
          react: {
            version: "detect",
          },
        }),
      },
    },

    // Prettier config (must be last)
    prettierConfig,
  ];
}
