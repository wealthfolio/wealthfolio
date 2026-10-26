# Frontend tooling

Use the Node version in `.node-version` and the pnpm version in `package.json`.
Install with `pnpm install --frozen-lockfile`.

## TypeScript

The `@typescript/native` dependency aliases TypeScript 7 and provides `tsc` for
type checks, frontend builds, and package declarations. The `typescript`
dependency aliases `@typescript/typescript6`, which provides the compiler API
needed by typescript-eslint and other tools. Its executable is `tsc6`, so it
does not replace the native compiler's `tsc`.

Keep these aliases consistent across the root, frontend, UI, and SDK manifests.
This follows Microsoft's
[side-by-side compiler setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

`pnpm type-check` builds the shared declarations before checking consumers. The
UI and SDK explicitly retain `rootDir: "."`: their published exports point to
`dist/src/*.d.ts`. The frontend's TypeScript aliases default to Tauri, so type
checking alone does not verify both runtime configurations. Use `pnpm build` and
`pnpm build:tauri` when changing shared tooling.

## Linting

`pnpm lint` runs typed Oxlint across the frontend, UI, and SDK, followed by the
remaining ESLint rules. `pnpm lint:quiet` and `pnpm lint:fix` use the same
scope. Each workspace also exposes these commands independently.

`oxlint.base.json` contains the migrated ESLint recommended rules and the
typescript-eslint recommended/stylistic typed rules, with the existing
severities and exceptions. Workspace `.oxlintrc.json` files retain SDK
restrictions, React Refresh checks, and the frontend's formatting-import
restriction, including its test and utility-file exemptions. Custom hook
dependency checks still include `useEffectOnChange`.

The ESLint configuration intentionally retains:

- TanStack Query rules, including the typed `no-void-query-fn` rule. Oxlint's
  JavaScript plugin bridge cannot supply TypeScript parser services.
- `react/no-deprecated`, whose React-specific behavior is not equivalent to
  TypeScript's general deprecation rule.
- `no-unsafe-optional-chaining`, preserving ESLint's handling of TypeScript
  assertions. Oxlint additionally reports asserted optional chains that the
  existing ESLint rule accepts.

Oxlint handles JSX variable usage itself. Its parser and TypeScript handle the
strict-mode syntax checks formerly supplied by `no-dupe-args` and `no-octal`.
Lint diagnostics may differ between implementations; new rule policies should be
changed separately from the tooling migration.

`node --test scripts/frontend-tooling.test.mjs` checks typed linting, SDK
strictness, custom hook dependencies, import restriction exemptions, JavaScript
globals, and the retained ESLint checks. It also runs through
`pnpm test:scripts`.

## Formatting and editors

`pnpm format` and `pnpm format:check` use Oxfmt. Root and package configs
preserve the existing quote styles, line widths, Markdown overrides, Tailwind
sorting, and ignored paths. Package-field and import sorting remain disabled.
TOML stays outside formatting, as it was with Prettier.

The theme generator uses Oxfmt's API with the root formatter options and rejects
formatter errors. `pnpm themes:check` verifies that its committed output remains
current.

VS Code and devcontainers recommend Oxc, ESLint for the retained checks, and the
TypeScript native language server. The committed editor settings use Oxfmt on
save and run both linters' fixes. The agent formatting hook also uses Oxfmt.
