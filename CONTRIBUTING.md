# Contributing to Wealthfolio

Thank you for your interest in contributing to Wealthfolio! We welcome
contributions from the community.

## Contributor License Agreement (CLA)

We require a CLA for all contributions.

By submitting a pull request, you confirm you have read and agree to
[CLA.md](CLA.md). PRs without CLA agreement will not be merged.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in
   [Issues](https://github.com/wealthfolio/wealthfolio/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, version, etc.)

### Suggesting Features

1. Check existing issues and discussions for similar suggestions
2. Open a new issue describing:
   - The problem you're trying to solve
   - Your proposed solution
   - Any alternatives you've considered

### Submitting Code

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Ensure tests pass and code follows project style
5. Commit your changes with clear, descriptive messages
6. Push to your fork (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Setup

See the [README](README.md#getting-started) for detailed setup instructions. The
[frontend tooling guide](docs/frontend-tooling.md) covers the pinned Node and
pnpm versions, editor extensions, and updating an existing checkout.

For frontend changes, run:

```bash
pnpm check
pnpm test:scripts
pnpm --filter frontend exec vitest run
```

`pnpm check` checks generated themes, formatting, lint, and types. Tests and
builds run separately; see the tooling guide for the web and Tauri build checks.

### Optional Git Hooks

Install the tracked Git hooks to run CI-equivalent checks before `git push`:

```bash
pnpm hooks:install
```

Git does not enable repository hooks automatically, so each contributor must opt
in once per clone.

### Code Style

- **Rust**: Follow standard Rust conventions, use `cargo fmt` and `cargo clippy`
- **TypeScript/React**: Use Oxfmt for formatting and typed Oxlint plus the
  retained ESLint checks for linting. Run `pnpm format` or `pnpm lint:fix` to
  apply fixes.
- **Commits**: Write clear, concise commit messages

## Code of Conduct

Please be respectful and constructive in all interactions. We're building
something together!

## Questions?

- Join our [Discord](https://discord.gg/WDMCY6aPWK)
- Open a [Discussion](https://github.com/wealthfolio/wealthfolio/discussions)
- Email: hello@wealthfolio.app

## License

By contributing, you agree that your contributions will be licensed under the
project's [AGPL-3.0 license](LICENSE), subject to the terms of our
[CLA](CLA.md).

---

Wealthfolio is a trademark of Teymz Inc. See [TRADEMARKS.md](TRADEMARKS.md) for
trademark policy.
