import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

const fixture = vi.hoisted(() => ({
  tauri: true,
  preferredProvider: null as "email" | "google" | null,
  signInWithOAuth: vi.fn(),
  signInWithMagicLink: vi.fn(),
  verifyOtp: vi.fn(),
  clearError: vi.fn(),
  savePreferredProvider: vi.fn(),
  mfaChallenge: null as "sign-in" | "restore" | null,
  sessionEnded: false,
  verifyMfaCode: vi.fn(),
  cancelMfaChallenge: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  get isTauri() {
    return fixture.tauri;
  },
  openUrlInBrowser: vi.fn(),
}));
vi.mock("@/lib/cookie-utils", () => ({
  getPreferredProvider: () => fixture.preferredProvider,
  savePreferredProvider: fixture.savePreferredProvider,
}));
vi.mock("../providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => ({ ...fixture, error: null, isLoading: false }),
}));
vi.mock("./connect-features", () => ({ ConnectFeatures: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  document.elementFromPoint = () => null;
  fixture.tauri = true;
  fixture.preferredProvider = null;
  fixture.mfaChallenge = null;
  fixture.sessionEnded = false;
  fixture.signInWithOAuth.mockResolvedValue(undefined);
  fixture.signInWithMagicLink.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const googleLabel = "connect:providers.continueWithGoogle";
const emailLabel = "connect:providers.continueWithEmail";

describe("Connect sign-in choices", () => {
  it.each([null, "email", "google"] as const)(
    "shows both native methods without expanding anything, preference %s",
    (preferred) => {
      fixture.preferredProvider = preferred;
      render(<LoginForm />);
      expect(screen.getByRole("button", { name: new RegExp(googleLabel) })).toBeTruthy();
      expect(screen.getByRole("button", { name: new RegExp(emailLabel) })).toBeTruthy();
      expect(screen.queryByText("auth:connect.moreSignInOptions")).toBeNull();
      expect(screen.getAllByRole("button")[0].textContent).toContain(
        preferred === "email" ? emailLabel : googleLabel,
      );
    },
  );

  it("keeps self-hosted web email-only, even with a saved Google preference", () => {
    fixture.tauri = false;
    fixture.preferredProvider = "google";
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: emailLabel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: googleLabel })).toBeNull();
    expect(screen.queryByText("auth:connect.or")).toBeNull();
  });

  it("starts Google sign-in directly and remembers the choice", async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: googleLabel }));
    await waitFor(() => expect(fixture.savePreferredProvider).toHaveBeenCalledWith("google"));
    expect(fixture.signInWithOAuth).toHaveBeenCalledWith("google");
    expect(fixture.signInWithMagicLink).not.toHaveBeenCalled();
  });

  it.each(["google", "email"] as const)("blocks the other method while %s is pending", (method) => {
    const pending = new Promise(() => undefined);
    fixture.signInWithOAuth.mockReturnValue(pending);
    fixture.signInWithMagicLink.mockReturnValue(pending);
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("auth:connect.emailLabel"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: method === "google" ? googleLabel : emailLabel }),
    );
    const other = screen.getByRole("button", {
      name: method === "google" ? emailLabel : googleLabel,
    });
    expect(other).toBeDisabled();
    fireEvent.click(other);
    expect(
      method === "google" ? fixture.signInWithMagicLink : fixture.signInWithOAuth,
    ).not.toHaveBeenCalled();
  });

  it("moves email sign-in to the code step without leaving alternative buttons visible", async () => {
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("auth:connect.emailLabel"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: emailLabel }));
    await waitFor(() => expect(screen.getByText("auth:connect.otp.title")).toBeTruthy());
    expect(fixture.signInWithMagicLink).toHaveBeenCalledWith("demo@example.com");
    expect(screen.queryByRole("button", { name: googleLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: emailLabel })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "auth:connect.otp.backToSignIn" }));
    expect(screen.getByRole("button", { name: googleLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: emailLabel })).toBeTruthy();
  });
});

describe("Two-factor code step", () => {
  it.each([
    [true, "sign-in"],
    [false, "sign-in"],
    [true, "restore"],
  ] as const)("replaces the sign-in options (desktop: %s, %s)", async (tauri, challenge) => {
    fixture.tauri = tauri;
    fixture.mfaChallenge = challenge;
    fixture.verifyMfaCode.mockResolvedValue(undefined);
    render(<LoginForm />);
    expect(screen.getByText("auth:connect.mfa.title")).toBeTruthy();
    expect(screen.queryByLabelText("auth:connect.emailLabel")).toBeNull();
    expect(screen.queryByRole("button", { name: googleLabel })).toBeNull();
    fireEvent.change(screen.getByLabelText("auth:connect.mfa.codeLabel"), {
      target: { value: "123456" },
    });
    await waitFor(() => expect(fixture.verifyMfaCode).toHaveBeenCalledWith("123456"));
  });

  it("leaves the email code behind once the authenticator step takes over", async () => {
    fixture.verifyOtp.mockResolvedValue(undefined);
    const { rerender } = render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("auth:connect.emailLabel"), {
      target: { value: "demo@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: emailLabel }));
    await screen.findByText("auth:connect.otp.title");
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "654321" } });
    await waitFor(() =>
      expect(fixture.verifyOtp).toHaveBeenCalledWith("demo@example.com", "654321"),
    );
    fixture.mfaChallenge = "sign-in";
    rerender(<LoginForm />);
    expect(await screen.findByText("auth:connect.mfa.title")).toBeTruthy();
    // "Sign out" from the code step returns to the sign-in choices, not the email code.
    fixture.mfaChallenge = null;
    rerender(<LoginForm />);
    expect(screen.queryByText("auth:connect.otp.title")).toBeNull();
    expect(screen.getByRole("button", { name: emailLabel })).toBeTruthy();
  });
});

describe("Signed out by the auth server", () => {
  it("says why and keeps the sign-in choices", () => {
    fixture.sessionEnded = true;
    render(<LoginForm />);
    expect(screen.getByText("auth:connect.sessionEnded.title")).toBeTruthy();
    expect(screen.getByText("auth:connect.sessionEnded.description")).toBeTruthy();
    expect(screen.getByRole("button", { name: googleLabel })).toBeTruthy();
  });

  it("gives way to the code step after signing in", () => {
    fixture.sessionEnded = true;
    fixture.mfaChallenge = "sign-in";
    render(<LoginForm />);
    expect(screen.getByText("auth:connect.mfa.title")).toBeTruthy();
    expect(screen.queryByText("auth:connect.sessionEnded.title")).toBeNull();
  });
});
