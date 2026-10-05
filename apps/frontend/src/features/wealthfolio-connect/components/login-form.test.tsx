import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

const fixture = vi.hoisted(() => ({
  desktop: true,
  preferredProvider: null as "email" | "google" | null,
  signInWithOAuth: vi.fn(),
  signInWithMagicLink: vi.fn(),
  verifyOtp: vi.fn(),
  clearError: vi.fn(),
  savePreferredProvider: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  get isDesktop() {
    return fixture.desktop;
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
  fixture.desktop = true;
  fixture.preferredProvider = null;
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
    fixture.desktop = false;
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
