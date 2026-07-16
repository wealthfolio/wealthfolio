import { describe, expect, it } from "vitest";
import { parseAuthCallbackUrl } from "./auth-callback";

describe("parseAuthCallbackUrl", () => {
  it("accepts the desktop custom auth callback", () => {
    expect(parseAuthCallbackUrl("wealthfolio://auth/callback?code=abc")).toEqual({
      type: "code",
      code: "abc",
    });
  });

  it("accepts the configured hosted callback page used by OAuth", () => {
    expect(
      parseAuthCallbackUrl("https://auth.example.com/callback/deeplink?code=abc", {
        hostedCallbackUrl: "https://auth.example.com/callback/deeplink",
      }),
    ).toEqual({
      type: "code",
      code: "abc",
    });
  });

  it("rejects hosted callback URLs that do not match the configured callback", () => {
    expect(
      parseAuthCallbackUrl("https://connect.wealthfolio.app/deeplink?code=abc", {
        hostedCallbackUrl: "https://auth.example.com/callback/deeplink",
      }),
    ).toBeNull();
  });

  it("accepts the current app origin web callback", () => {
    expect(
      parseAuthCallbackUrl("http://localhost:1420/auth/callback?code=abc", {
        appOrigin: "http://localhost:1420",
      }),
    ).toEqual({
      type: "code",
      code: "abc",
    });
  });

  it("rejects untrusted URLs that happen to include a code", () => {
    expect(parseAuthCallbackUrl("https://example.com/auth/callback?code=abc")).toBeNull();
    expect(parseAuthCallbackUrl("wealthfolio://connect/link-device?code=abc")).toBeNull();
  });

  it("reports token callbacks on trusted auth URLs as configuration errors", () => {
    expect(parseAuthCallbackUrl("wealthfolio://auth/callback#access_token=token")).toMatchObject({
      type: "error",
    });
  });
});
