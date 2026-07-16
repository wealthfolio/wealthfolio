# @wealthfolio/addon-dev-tools

Development tools for Wealthfolio addons including hot reload server and CLI.

## Installation

```bash
npm install -g @wealthfolio/addon-dev-tools
```

> **Deprecation note:** the CLI command is now `wealthfolio-addon`. The old
> `wealthfolio` alias still works but will be removed in a future release — the
> `wealthfolio` name is reserved for the upcoming native Wealthfolio CLI.

## CLI Commands

### Create New Addon

```bash
wealthfolio-addon create my-awesome-addon
```

### Start Development Server

```bash
# In your addon directory
wealthfolio-addon dev
```

### Build Addon

```bash
wealthfolio-addon build
```

### Package for Distribution

```bash
wealthfolio-addon package
```

### Test Setup

```bash
wealthfolio-addon test
```

## Development Server

The development server provides:

- Hot reload functionality
- File watching
- Auto-building
- Health check endpoints

### API Endpoints

- `GET /health` - Health check
- `GET /status` - Addon status and last modified time
- `GET /manifest.json` - Addon manifest
- `GET /addon.js` - Built addon code
- `GET /files` - List of built files
- `GET /test` - Test connectivity

## Usage in Addon Projects

Add to your addon's `package.json`:

```json
{
  "scripts": {
    "dev:server": "wealthfolio-addon dev"
  },
  "devDependencies": {
    "@wealthfolio/addon-dev-tools": "^1.0.0"
  }
}
```

## Architecture

This package is separate from `@wealthfolio/addon-sdk` to:

- Keep the SDK lightweight for production
- Avoid unnecessary dependencies in addon bundles
- Provide optional development tooling

## License

MIT
