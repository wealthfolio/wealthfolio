import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaCodeStep } from "./mfa-code-step";

const fixture = vi.hoisted(() => ({
  verifyMfaCode: vi.fn(),
  cancelMfaChallenge: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@/adapters", () => ({ openUrlInBrowser: fixture.openUrl }));
vi.mock("../providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => fixture,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const codeInput = () => screen.getByLabelText("auth:connect.mfa.codeLabel");

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  // input-otp looks for password-manager badges next to the focused field.
  document.elementFromPoint = () => null;
  fixture.verifyMfaCode.mockResolvedValue(undefined);
  fixture.cancelMfaChallenge.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Authenticator code step", () => {
  it("submits by itself once six digits are typed", async () => {
    render(<MfaCodeStep />);
    expect(screen.getByText("auth:connect.mfa.title")).toBeTruthy();
    fireEvent.change(codeInput(), { target: { value: "12345" } });
    expect(fixture.verifyMfaCode).not.toHaveBeenCalled();
    fireEvent.change(codeInput(), { target: { value: "123456" } });
    await waitFor(() => expect(fixture.verifyMfaCode).toHaveBeenCalledWith("123456"));
    expect(fixture.verifyMfaCode).toHaveBeenCalledTimes(1);
  });

  it("accepts a pasted code with a space in the middle", async () => {
    render(<MfaCodeStep />);
    fireEvent.paste(codeInput(), {
      clipboardData: { getData: () => "123 456" },
    });
    await waitFor(() => expect(fixture.verifyMfaCode).toHaveBeenCalledWith("123456"));
  });

  it("explains a rejected code and clears the field for another try", async () => {
    fixture.verifyMfaCode.mockRejectedValueOnce(
      Object.assign(new Error("Invalid TOTP code entered"), { code: "mfa_verification_failed" }),
    );
    render(<MfaCodeStep />);
    fireEvent.change(codeInput(), { target: { value: "000000" } });
    expect(await screen.findByText("auth:connect.mfa.invalidCode")).toBeTruthy();
    expect((codeInput() as HTMLInputElement).value).toBe("");
  });

  it("shows other failures as they are", async () => {
    fixture.verifyMfaCode.mockRejectedValueOnce(new Error("Network request failed"));
    render(<MfaCodeStep />);
    fireEvent.change(codeInput(), { target: { value: "123456" } });
    expect(await screen.findByText("Network request failed")).toBeTruthy();
  });

  it("signs out from the code step", async () => {
    render(<MfaCodeStep />);
    fireEvent.click(screen.getByRole("button", { name: "auth:connect.mfa.signOut" }));
    await waitFor(() => expect(fixture.cancelMfaChallenge).toHaveBeenCalledTimes(1));
    expect(fixture.verifyMfaCode).not.toHaveBeenCalled();
  });

  it("points people without their authenticator to support", () => {
    render(<MfaCodeStep />);
    const link = screen.getByRole("link", { name: "auth:connect.mfa.cantUseAuthenticator" });
    expect(link.getAttribute("href")).toBe("mailto:support@wealthfolio.app");
  });
});
