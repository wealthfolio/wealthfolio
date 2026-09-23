import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DialogTitle } from "@wealthfolio/ui/components/ui/dialog";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { EnterCode } from "./enter-code";

const scanner = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  scan: vi.fn(),
  cancel: vi.fn(),
  Format: { QRCode: "QR_CODE" },
}));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => scanner);
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: true }) }));
vi.mock("@/adapters", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The segmented code field measures itself; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

// input-otp schedules short timers after it renders; let them run before the
// test environment is torn down, or they fire into a missing window.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 200)));

beforeEach(() => {
  vi.clearAllMocks();
  scanner.checkPermissions.mockResolvedValue("granted");
  scanner.scan.mockImplementation(() => new Promise(() => {}));
  scanner.cancel.mockResolvedValue(undefined);
});

it("closes on one press even when the native scan promise stays pending", async () => {
  render(
    <EnterCode
      title="Connect"
      description="Enter the code"
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("sync:enterCode.scanQrCode"));
  await waitFor(() => expect(scanner.scan).toHaveBeenCalled());
  const button = document.querySelector(".qr-overlay button")!;
  await userEvent.setup().click(button);
  await waitFor(() => expect(document.querySelector(".qr-overlay")).toBeNull());
  expect(scanner.cancel).toHaveBeenCalledTimes(1);
  expect(document.body.classList.contains("qr-scan-active")).toBe(false);
});

it("explains when the native scanner reports no camera and restores the form", async () => {
  scanner.scan.mockRejectedValue({
    message: "No camera available on this device (e.g., iOS Simulator)",
  });
  render(
    <EnterCode
      title="Connect"
      description="Enter the code"
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("sync:enterCode.scanQrCode"));
  expect(await screen.findByRole("alert")).toHaveTextContent("sync:enterCode.cameraUnavailable");
  expect(document.body.classList.contains("qr-scan-active")).toBe(false);
});

for (const mobile of [false, true]) {
  it(`keeps scanner keyboard focus above the pairing ${mobile ? "sheet" : "dialog"} and restores it on Cancel and Escape`, async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <Dialog open useIsMobile={() => mobile}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Pair this device</DialogTitle>
          <EnterCode
            title="Connect"
            description="Enter the code"
            onSubmit={vi.fn()}
            onCancel={onCancel}
          />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: /sync:enterCode.scanQrCode/ });
    await user.click(trigger);
    await waitFor(() => expect(scanner.scan).toHaveBeenCalled());
    const overlay = document.querySelector<HTMLElement>(".qr-overlay")!;
    const cancel = within(overlay).getByRole("button", { name: "common:cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector(".qr-overlay")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Pair this device" })).toBeVisible();
    expect(onCancel).not.toHaveBeenCalled();
    expect(scanner.cancel).toHaveBeenCalledTimes(1);
    await user.click(trigger);
    await waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(2));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".qr-overlay")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Pair this device" })).toBeVisible();
    expect(onCancel).not.toHaveBeenCalled();
    expect(scanner.cancel).toHaveBeenCalledTimes(2);
  });
}

// A mistyped code used to replace the form with a failure screen and lose the code.
it("submits a complete code and keeps it on screen with its error until edited", () => {
  const onSubmit = vi.fn();
  const props = { title: "Connect", description: "Enter the code", onCancel: vi.fn(), onSubmit };
  const { rerender } = render(<EnterCode {...props} />);
  const input = screen.getByRole("textbox", { name: "sync:enterCode.codeLabel" });

  fireEvent.change(input, { target: { value: "abc123" } });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith("ABC123");

  rerender(<EnterCode {...props} error="Invalid pairing code" />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(input).toHaveValue("ABC123");
  expect(input).toHaveAttribute("aria-invalid", "true");

  fireEvent.change(input, { target: { value: "ABC12" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("submits a complete code as soon as it is pasted", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue(" xyz 789\n") },
  });
  const onSubmit = vi.fn();
  render(
    <EnterCode
      title="Connect"
      description="Enter the code"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "sync:enterCode.paste" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("XYZ789"));
});

// Review finding: disabling the field while checking dropped keyboard focus,
// so a rejected code could not be fixed by just typing again.
it("keeps the code field focusable while the code is checked", () => {
  render(
    <EnterCode
      title="Connect"
      description="Enter the code"
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      isLoading
    />,
  );
  const input = screen.getByRole("textbox", { name: "sync:enterCode.codeLabel" });
  expect(input).not.toBeDisabled();
  expect(input).toHaveAttribute("readonly");
});
