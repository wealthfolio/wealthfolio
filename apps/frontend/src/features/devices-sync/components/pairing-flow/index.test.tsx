import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayCode } from "./display-code";
import { AddDeviceWizard, JoinDeviceWizard } from "./index";

const hookMocks = vi.hoisted(() => ({
  useSyncStatus: vi.fn(),
  usePairingIssuer: vi.fn(),
  usePairingClaimer: vi.fn(),
}));

vi.mock("../../hooks", () => ({
  useSyncStatus: hookMocks.useSyncStatus,
  usePairingIssuer: hookMocks.usePairingIssuer,
  usePairingClaimer: hookMocks.usePairingClaimer,
}));

vi.mock("@/adapters", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

function mutation() {
  return { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
}

function restoreController() {
  return { approve: mutation(), retry: mutation(), cancel: mutation(), start: mutation() };
}

function claimerRestoring(phase: string, controller = restoreController()) {
  hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "untrusted" } });
  hookMocks.usePairingIssuer.mockReturnValue({});
  hookMocks.usePairingClaimer.mockReturnValue({
    step: "restoring",
    error: null,
    sas: null,
    operation: {
      operationId: "op-1",
      revision: 3,
      phase,
      snapshot: null,
      error: null,
      replaced: phase === "ready",
    },
    restore: controller,
    submitCode: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  });
  return controller;
}

describe("Device setup wizards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the source device to finish on the receiving device", () => {
    hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "trusted" } });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "success",
      error: null,
      sas: null,
      pairingCode: null,
      expiresAt: null,
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Devices connected")).toBeInTheDocument();
    expect(screen.getByText(/Finish setup on your other device/)).toBeInTheDocument();
    expect(screen.queryByText("You're all set!")).not.toBeInTheDocument();
  });

  it("shows replacement consent in the pairing window and backs up by default", () => {
    const controller = claimerRestoring("awaiting_consent");

    render(<JoinDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Replace the data in this profile?")).toBeInTheDocument();
    expect(screen.getByText(/Data from your other device/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Back up this profile first/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Back up and replace" }));
    expect(controller.approve.mutateAsync).toHaveBeenCalledTimes(1);
    expect(controller.approve.mutateAsync).toHaveBeenCalledWith({
      operationId: "op-1",
      backup: true,
    });
  });

  it("replaces without a backup when the user opts out", () => {
    const controller = claimerRestoring("awaiting_consent");

    render(<JoinDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Back up this profile first/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace data" }));

    expect(controller.approve.mutateAsync).toHaveBeenCalledWith({
      operationId: "op-1",
      backup: false,
    });
  });

  it("finishes only when the runtime reports ready", () => {
    const onComplete = vi.fn();
    claimerRestoring("replacing");
    const { rerender } = render(<JoinDeviceWizard onComplete={onComplete} onCancel={vi.fn()} />);
    expect(screen.getByText("Replacing data on this device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();

    claimerRestoring("ready");
    rerender(<JoinDeviceWizard onComplete={onComplete} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shows restore-required issuer errors as a normal PairingResult error", () => {
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "trusted" },
    });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "error",
      error:
        "SYNC_SOURCE_RESTORE_REQUIRED: Local sync state is ahead of the last confirmed sync state on the server.",
      needsRestore: true,
      sas: null,
      pairingCode: null,
      expiresAt: null,
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    // Falls through to PairingResult which formats the error nicely
    expect(screen.getByText("Couldn't connect")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sync needs to be restored from this device before you can connect another device.",
      ),
    ).toBeInTheDocument();
  });

  it("hides technical pairing error details from users", () => {
    const error =
      "Database operation failed: Internal database error: Database operation failed: Foreign key violation: spending_activity_events.activity_id references missing broker activity broker-local-id-1234567890";
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "trusted" },
    });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "error",
      error,
      needsRestore: false,
      sas: null,
      pairingCode: null,
      expiresAt: null,
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByText(error)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Sync could not finish. Please try again. If this keeps happening, check the app logs.",
      ),
    ).toBeInTheDocument();
  });

  it("shows portfolio repair guidance without database details", () => {
    const error =
      'Cannot upload snapshot: Database operation failed: Foreign key violation: Portfolio "Retirement" contains a deleted account link (account_id=acc-upload-missing). Open Settings > Portfolios, edit the portfolio, then save.';
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "trusted" },
    });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "error",
      error,
      needsRestore: false,
      sas: null,
      pairingCode: null,
      expiresAt: null,
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByText(error)).not.toBeInTheDocument();
    expect(screen.queryByText(/account_id=acc-upload-missing/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Portfolio "Retirement" contains a deleted account link. Open Settings > Portfolios, edit the portfolio, then save.',
      ),
    ).toBeInTheDocument();
  });

  it("does not render unrecognized technical pairing errors", () => {
    const error = "No device ID configured";
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "trusted" },
    });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "error",
      error,
      needsRestore: false,
      sas: null,
      pairingCode: null,
      expiresAt: null,
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.queryByText(error)).not.toBeInTheDocument();
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  // Regression: after "They don't match" the issuer showed a spinner forever,
  // because the flow never started a new pairing.
  it("stops pairing when the codes don't match and offers a new code", () => {
    const startPairing = vi.fn();
    const rejectSAS = vi.fn().mockResolvedValue(undefined);
    hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "trusted" } });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "verify_sas",
      error: null,
      sas: "K7Q2M9",
      pairingCode: "ABC123",
      expiresAt: new Date(Date.now() + 60_000),
      startPairing,
      confirmSAS: vi.fn(),
      rejectSAS,
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "They don't match" }));

    expect(rejectSAS).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pairing stopped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(startPairing).toHaveBeenCalledTimes(1);
  });

  it("marks the new device's step while the restore runs", () => {
    claimerRestoring("replacing");
    render(<JoinDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("wizard-step-connect")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("wizard-step-download")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("wizard-step-apply")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("wizard-step-done")).toHaveAttribute("data-state", "pending");
    // A running restore can be hidden; it keeps going in the background.
    expect(screen.getByRole("button", { name: "Continue in background" })).toBeInTheDocument();
  });

  // Success is the wizard's last step, not a separate screen.
  it("ends on the Done step with every earlier step completed", () => {
    claimerRestoring("ready");
    render(<JoinDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-done")).toHaveAttribute("aria-current", "step");
    for (const step of ["connect", "download", "apply"]) {
      expect(screen.getByTestId(`wizard-step-${step}`)).toHaveAttribute("data-state", "done");
    }
  });

  // Review finding: this screen waits on a network call and had no way out.
  it("lets the new device leave while the connection is secured", () => {
    const onCancel = vi.fn();
    const cancel = vi.fn();
    hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "untrusted" } });
    hookMocks.usePairingIssuer.mockReturnValue({});
    hookMocks.usePairingClaimer.mockReturnValue({
      step: "confirming",
      error: null,
      sas: "4F8R2Z",
      operation: null,
      restore: restoreController(),
      submitCode: vi.fn(),
      cancel,
      retry: vi.fn(),
    });
    render(<JoinDeviceWizard onComplete={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByText("Securing the connection")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Hiding only: a confirmation in flight is not cancelled on the server.
    expect(cancel).not.toHaveBeenCalled();
  });

  // The transfer runs in this window, so it must not be closed until it ends.
  it("offers no way to leave while this device transfers its data", () => {
    hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "trusted" } });
    hookMocks.usePairingIssuer.mockReturnValue({
      step: "transferring",
      error: null,
      sas: "K7Q2M9",
      pairingCode: "ABC123",
      expiresAt: new Date(Date.now() + 60_000),
      startPairing: vi.fn(),
      confirmSAS: vi.fn(),
      rejectSAS: vi.fn(),
      cancel: vi.fn(),
      reset: vi.fn(),
    });
    hookMocks.usePairingClaimer.mockReturnValue({});

    render(<AddDeviceWizard onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Transferring your data")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-transfer")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("DisplayCode", () => {
  // Regression: an expired code kept showing a scannable QR code.
  it("replaces an expired code with a way to get a new one", () => {
    const onRenew = vi.fn();
    render(
      <DisplayCode
        title="Connect another device"
        description="Scan this code"
        code="ABC123"
        expiresAt={new Date(Date.now() - 1_000)}
        onCancel={vi.fn()}
        onRenew={onRenew}
      />,
    );

    expect(screen.getByText("This code has expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(onRenew).toHaveBeenCalledTimes(1);
  });

  it("shows the time left and copies the code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <DisplayCode
        title="Connect another device"
        description="Scan this code"
        code="ABC123"
        expiresAt={new Date(Date.now() + 125_000)}
        onCancel={vi.fn()}
        onRenew={vi.fn()}
      />,
    );

    expect(screen.getByText(/Expires in 2:0\d/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("ABC123");
    expect(await screen.findAllByText("Copied")).not.toHaveLength(0);
  });
});
