import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PairingFlow } from "./index";

const hookMocks = vi.hoisted(() => ({
  backupDatabase: vi.fn(),
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
  backupDatabase: hookMocks.backupDatabase,
}));

describe("PairingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows success step for claimer flow", () => {
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "untrusted" },
    });
    hookMocks.usePairingClaimer.mockReturnValue({
      step: "success",
      error: null,
      sas: null,
      submitCode: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
    });
    hookMocks.usePairingIssuer.mockReturnValue({});

    render(<PairingFlow />);

    expect(screen.getByText("You're all set!")).toBeInTheDocument();
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

    render(<PairingFlow />);

    // Falls through to PairingResult which formats the error nicely
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
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

    render(<PairingFlow />);

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

    render(<PairingFlow />);

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

    render(<PairingFlow />);

    expect(screen.queryByText(error)).not.toBeInTheDocument();
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("shows claimer overwrite prompt and approves overwrite once", () => {
    const approveOverwrite = vi.fn();
    hookMocks.useSyncStatus.mockReturnValue({
      device: { trustState: "untrusted" },
    });
    hookMocks.usePairingClaimer.mockReturnValue({
      step: "overwrite_required",
      error: null,
      sas: null,
      overwriteInfo: {
        localRows: 1,
        nonEmptyTables: [{ table: "accounts", rows: 1 }],
      },
      isApprovingOverwrite: false,
      submitCode: vi.fn(),
      approveOverwrite,
      cancel: vi.fn(),
      retry: vi.fn(),
    });
    hookMocks.usePairingIssuer.mockReturnValue({});

    render(<PairingFlow />);

    expect(screen.getByText("Replace data on this device?")).toBeInTheDocument();
    const replaceButton = screen.getByRole("button", { name: "Replace & Sync" });
    expect(replaceButton.parentElement).toHaveClass(
      "max-sm:[&>button]:whitespace-normal",
      "sm:flex-wrap",
    );
    fireEvent.click(replaceButton);
    expect(approveOverwrite).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    "requires a successful managed backup before overwrite (success=%s)",
    async (succeeds) => {
      const approveOverwrite = vi.fn();
      let finish!: () => void;
      hookMocks.backupDatabase.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              succeeds ? resolve({ filename: "managed.db" }) : reject(new Error("disk full"));
          }),
      );
      hookMocks.useSyncStatus.mockReturnValue({ device: { trustState: "untrusted" } });
      hookMocks.usePairingIssuer.mockReturnValue({});
      hookMocks.usePairingClaimer.mockReturnValue({
        step: "overwrite_required",
        overwriteInfo: { localRows: 1, nonEmptyTables: [] },
        isApprovingOverwrite: false,
        approveOverwrite,
        cancel: vi.fn(),
      });
      render(<PairingFlow />);
      fireEvent.click(screen.getByRole("button", { name: "Back up first" }));
      expect(hookMocks.backupDatabase).toHaveBeenCalledTimes(1);
      expect(approveOverwrite).not.toHaveBeenCalled();
      finish();
      if (succeeds) {
        await waitFor(() => expect(approveOverwrite).toHaveBeenCalledTimes(1));
      } else {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Back up first" })).toBeEnabled(),
        );
        expect(approveOverwrite).not.toHaveBeenCalled();
      }
    },
  );
});
