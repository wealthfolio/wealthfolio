# Frontend tooling

Use the Node version in `.node-version` and the pnpm version in `package.json`.
Install with `pnpm install --frozen-lockfile`.

## Updating an existing checkout

After pulling the tooling update, select the Node version in `.node-version` and
the pnpm version in `package.json`, then run:

```bash
pnpm install --frozen-lockfile
pnpm build:types
pnpm check
```

The install supplies the platform-specific compiler, linter, and formatter
binaries. Keep optional dependencies enabled; no separate Go installation or
Rust build is needed for these frontend checks. Rust is still required for
building and running Wealthfolio's native applications and server.

In VS Code, install the recommended Oxc, ESLint, and TypeScript native
extensions from `.vscode/extensions.json`, then reload the window. Oxfmt
replaces Prettier as the workspace formatter; keep ESLint enabled for the
retained checks. The workspace settings enable TypeScript 7 and point its SDK
path to `node_modules/@typescript/native`, rather than the TypeScript 6 API
compatibility package. To enable it manually, open a TypeScript file and run
`TypeScript: Enable TypeScript 7`; see the
[extension's setup instructions](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).
Other editors should use their Oxc and TypeScript 7 language-server
integrations. Rebuild an existing devcontainer to pick up its updated extension
list.

Installed Git hooks continue to call the same package scripts; reinstalling them
is unnecessary. For a new clone, `pnpm hooks:install` enables the optional
pre-push checks.

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
scope. Each workspace also exposes these commands independently. Workspace
commands run Oxlint from the repository root with their own directory as the
file scope, so root-only options such as unused-suppression reporting apply
consistently.

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

Use `oxlint-disable-*` comments for rules owned by Oxlint, such as
`react/exhaustive-deps` or `typescript/no-explicit-any`. Reserve
`eslint-disable-*` comments for retained ESLint rules, such as
`@tanstack/query/exhaustive-deps`.

## Formatting and editors

`pnpm format` and `pnpm format:check` use Oxfmt. The root `.oxfmtrc.json` and
its workspace overrides preserve the existing quote styles, line widths,
Markdown overrides, Tailwind sorting, and ignored paths. Package-field and
import sorting remain disabled. TOML stays outside formatting, as it was with
Prettier.

The theme generator uses Oxfmt's API with the root formatter options and rejects
formatter errors. `pnpm themes:check` verifies that its committed output remains
current.

VS Code and devcontainers recommend Oxc, ESLint for the retained checks, and the
TypeScript native language server. The committed editor settings use Oxfmt on
save and run both linters' fixes. The agent formatting hook also uses Oxfmt.

## GitHub Actions

Existing workflows continue to use the package scripts: `pnpm format:check`,
`pnpm lint`, `pnpm build:types`, package type checks, and frontend builds. The
PR and native build workflows select Node from `.node-version` and pnpm from
`package.json`; the lockfile selects the tooling versions. No new Actions job or
separately installed Go toolchain is required. The Docker frontend stage also
installs the tools from the same lockfile, using its Node 24 image.

The PR workflow builds package declarations before typed linting, and its
existing script-test step runs the tooling regression tests. The formatting
job's `pnpm install --frozen-lockfile --ignore-scripts` remains supported
because the formatter uses prebuilt platform binaries. Keep optional
dependencies and development dependencies enabled in jobs that run frontend
checks.

PR checks do not run the net-worth layout browser suite. Run
`pnpm test:e2e:net-worth` locally for relevant layout changes; see
[browser test setup](../e2e/README.md#ci-coverage-and-local-gates).

The existing Frontend Check job installs Chromium, Firefox, and WebKit and runs
the addon sandbox suite only when the `addon_sandbox` file filter is true. That
filter covers addon code, shared UI/SDK/dev-tool packages, sandbox styles and
localization, browser tests, build scripts/configuration, and dependencies. CI
workflow/helper changes also run it. Ordinary application pages and docs do not
require browsers. The exact paths live in
[the CI classifier](../.github/scripts/ci_changes.py); unit tests cover both
matching and unrelated paths. When requested, a failed sandbox suite still fails
Frontend Check and the required Build Status gate.
