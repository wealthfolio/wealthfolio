import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RestoreController, RestoreOperation } from "../hooks/use-restore-operation";
import { RestoreOperationView } from "./restore-operation-view";
import { restoreWizardProgress } from "./device-setup-steps";

vi.mock("@/adapters", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

function mutation() {
  return { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
}

function controller() {
  return {
    approve: mutation(),
    retry: mutation(),
    cancel: mutation(),
    start: mutation(),
  } as unknown as RestoreController & Record<string, ReturnType<typeof mutation>>;
}

function op(overrides: Partial<RestoreOperation>): RestoreOperation {
  return {
    operationId: "op-1",
    revision: 1,
    phase: "transferring",
    snapshot: null,
    error: null,
    replaced: false,
    ...overrides,
  };
}

function renderView(operation: RestoreOperation, restore = controller()) {
  render(<RestoreOperationView operation={operation} controller={restore} onClose={vi.fn()} />);
  return restore;
}

describe("RestoreOperationView", () => {
  it("retries a failed replacement, which asks for approval again", () => {
    const restore = renderView(
      op({
        phase: "failed",
        error: { code: "RESTORE_FAILED", message: "constraint failed", retry: "consent" },
      }),
    );

    expect(screen.getByText("The data couldn't be replaced")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(restore.retry.mutateAsync).toHaveBeenCalledWith("op-1");
    expect(restore.approve.mutateAsync).not.toHaveBeenCalled();
  });

  it("starts a new attempt when the selected copy is gone", () => {
    const restore = renderView(
      op({
        phase: "failed",
        error: { code: "SNAPSHOT_UNAVAILABLE", message: "gone", retry: "new_attempt" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(restore.start.mutateAsync).toHaveBeenCalledWith({
      newAttempt: true,
    });
    expect(restore.retry.mutateAsync).not.toHaveBeenCalled();
  });

  it("cancels while transferring and offers no approval", () => {
    const restore = renderView(op({ phase: "waiting_for_snapshot" }));

    expect(screen.getByText("Waiting for your other device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace data" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(restore.cancel.mutateAsync).toHaveBeenCalledWith("op-1");
  });

  it("finishes with a single Done action", () => {
    const onClose = vi.fn();
    render(
      <RestoreOperationView
        operation={op({ phase: "ready", replaced: true })}
        controller={controller()}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer cancellation once replacement started, but can be hidden", () => {
    const operation = op({ phase: "replacing" });
    renderView(operation);

    expect(
      screen.getByText("Putting the data from your other device in place."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel setup" })).not.toBeInTheDocument();
  });

  it("asks for consent in one sentence and backs up by default", () => {
    const restore = renderView(
      op({
        phase: "awaiting_consent",
        snapshot: { snapshotId: "snap-1", oplogSeq: 7, createdAt: "2026-09-22T11:31:00Z" },
      }),
    );

    expect(screen.getByText(/Data from your other device \(copied .+\)/)).toBeInTheDocument();
    expect(screen.queryByText(/rows/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Putting the data from your other device in place."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Back up this profile first" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Back up and replace" }));
    expect(restore.approve.mutateAsync).toHaveBeenCalledWith({ operationId: "op-1", backup: true });
  });

  // Working steps list their real sub-steps, following the restore's phase.
  it("shows where Apply stands while backing up", () => {
    renderView(op({ phase: "backing_up" }));

    const backup = screen.getByText("Back up this profile").closest("li");
    const replace = screen.getByText("Replace the data on this device").closest("li");
    expect(backup).toHaveAttribute("aria-current", "step");
    expect(replace).toHaveAttribute("data-state", "pending");
    expect(
      screen.getByText("You can close this window. Setup continues in the background."),
    ).toBeInTheDocument();
  });

  // The wizard's step count is fixed: approval is part of Apply, whether or
  // not this profile had data, so the step bar never grows mid-restore.
  it.each([
    [op({ phase: "transferring" }), { step: "download" }],
    [op({ phase: "waiting_for_snapshot" }), { step: "download" }],
    [op({ phase: "awaiting_consent" }), { step: "apply" }],
    [op({ phase: "replacing" }), { step: "apply" }],
    [op({ phase: "ready", replaced: true }), { step: "done" }],
    [
      op({ phase: "failed", error: { code: "TRANSFER_FAILED", message: "", retry: "transfer" } }),
      { step: "download", failed: true },
    ],
    [
      op({ phase: "failed", error: { code: "BACKUP_FAILED", message: "", retry: "consent" } }),
      { step: "apply", failed: true },
    ],
    [op({ phase: "cancelled" }), null],
  ])("places phase %# on the wizard's steps", (operation, expected) => {
    expect(restoreWizardProgress(operation)).toEqual(expected);
  });
});
