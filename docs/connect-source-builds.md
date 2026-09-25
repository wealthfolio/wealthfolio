# Wealthfolio Connect in source builds

Connect is optional when building Wealthfolio from source. Desktop and Docker
builds can use the same public authentication settings as the official app.

The auth URL and publishable key identify Wealthfolio's authentication service;
they are public application settings, not personal subscription credentials. Use
the values below rather than keys from your own Supabase project. Never replace
the publishable key with a secret or service-role key: these settings are
embedded in the frontend bundle. Sign in with your Wealthfolio account; paid
features require an eligible Connect subscription.

Both auth settings must be present at build time. If either is missing, Connect
is disabled and Settings shows "Wealthfolio Connect is not configured for this
build." The feature flag checks the build-time environment variables before the
authentication code can use its fallback values. Placeholder values do not
provide a working connection.

## Desktop

Follow the [source-build setup](../README.md#building-from-source), then replace
the Connect entries in the repository root `.env` with:

```dotenv
CONNECT_AUTH_URL=https://auth.wealthfolio.app
CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd
CONNECT_API_URL=https://api.wealthfolio.app
CONNECT_OAUTH_CALLBACK_URL=https://connect.wealthfolio.app/deeplink
```

The callback URL returns desktop OAuth sign-ins to the app.

When running `pnpm tauri dev` or building with `pnpm tauri build`, the frontend
and Rust backend read the root `.env` during their builds. To build without
Connect, leave both auth settings empty.

After changing these settings, restart development or rebuild the packaged app.
Setting environment variables when launching an already-built app does not
configure Connect.

## Docker

From the repository root, build your image with both authentication settings:

```bash
docker build -t wealthfolio-local:connect \
  --build-arg CONNECT_AUTH_URL=https://auth.wealthfolio.app \
  --build-arg CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd \
  .
```

Use `wealthfolio-local:connect` as the image in your existing Docker or Compose
deployment, keeping your volume and runtime configuration. The Connect API
defaults to `https://api.wealthfolio.app`. For general deployment configuration,
see the [self-hosting guide](self-host/README.md).

Setting these variables only at container startup (`docker run -e` or Compose
`environment`) will not enable Connect in an already-built frontend; rebuild the
image with both arguments. Local `.env` files are excluded from the Docker build
context, so pass the arguments explicitly. To build without Connect, omit both
arguments.

For web sign-in flows that use redirects, the authentication service must allow
your deployment's callback URL (`https://your-host/auth/callback`). Supplying
the build arguments does not register a new redirect URL.
