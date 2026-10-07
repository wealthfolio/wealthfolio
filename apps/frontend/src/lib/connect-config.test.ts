import { afterEach, expect, it, vi } from "vitest";
import defaults from "../../../../config/connect.defaults.json";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("uses the public callback default without enabling Connect", async () => {
  vi.stubEnv("CONNECT_OAUTH_CALLBACK_URL", "");
  vi.stubEnv("CONNECT_AUTH_URL", "");
  vi.stubEnv("CONNECT_AUTH_PUBLISHABLE_KEY", "");
  const config = await import("./connect-config");
  expect(config.CONNECT_OAUTH_CALLBACK_URL).toBe(defaults.oauthCallbackUrl);
  expect(config.CONNECT_ENABLED).toBe(false);
});

it("honors an explicit callback override", async () => {
  vi.stubEnv("CONNECT_OAUTH_CALLBACK_URL", "https://staging.test/deeplink");
  const config = await import("./connect-config");
  expect(config.CONNECT_OAUTH_CALLBACK_URL).toBe("https://staging.test/deeplink");
});

it.each([
  ["https://auth.test", "", false],
  ["", "synthetic", false],
  ["https://auth.test", "synthetic", true],
])("still requires both auth settings (%s, %s)", async (url, key, enabled) => {
  vi.stubEnv("CONNECT_AUTH_URL", url);
  vi.stubEnv("CONNECT_AUTH_PUBLISHABLE_KEY", key);
  const config = await import("./connect-config");
  expect(config.CONNECT_ENABLED).toBe(enabled);
});
