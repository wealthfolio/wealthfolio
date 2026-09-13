import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DialogTitle } from "@wealthfolio/ui/components/ui/dialog";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.clearAllMocks();
  scanner.checkPermissions.mockResolvedValue("granted");
  scanner.scan.mockImplementation(() => new Promise(() => {}));
  scanner.cancel.mockResolvedValue(undefined);
});

it("closes on one press even when the native scan promise stays pending", async () => {
  render(<EnterCode onSubmit={vi.fn()} onCancel={vi.fn()} />);
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
  render(<EnterCode onSubmit={vi.fn()} onCancel={vi.fn()} />);
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
          <EnterCode onSubmit={vi.fn()} onCancel={onCancel} />
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
