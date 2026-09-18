import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import settings from "@/i18n/locales/en/settings.json";
import { BackupExportDialog } from "./backup-export-dialog";

const exportBackup = vi.hoisted(() => vi.fn());
vi.mock("@/adapters", () => ({ exportDatabaseBackup: exportBackup }));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  exportBackup.mockReset();
  exportBackup.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to password protection and preserves the user's exact password", async () => {
  const onClose = vi.fn();
  render(<BackupExportDialog filename="selected.db" onClose={onClose} />);
  expect(screen.getByRole("radio", { name: settings.backup_export_protected })).toBeChecked();
  const password = "  user's 日本語 backup password  ";
  fireEvent.change(screen.getByLabelText(settings.backup_export_password), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(settings.backup_export_confirm_password), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() =>
    expect(exportBackup).toHaveBeenCalledWith(
      "selected.db",
      password,
      false,
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("requires a matching password and never exports after cancellation", () => {
  const onClose = vi.fn();
  render(<BackupExportDialog filename="selected.db" onClose={onClose} />);
  fireEvent.change(screen.getByLabelText(settings.backup_export_password), {
    target: { value: "long enough password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getByRole("alert")).toHaveTextContent(settings.backup_export_password_mismatch);
  expect(exportBackup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(exportBackup).not.toHaveBeenCalled();
});

it("generates matching passwords and toggles each field without submitting", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<BackupExportDialog filename="selected.db" onClose={vi.fn()} />);
  const password = screen.getByLabelText<HTMLInputElement>(settings.backup_export_password);
  const confirmation = screen.getByLabelText(settings.backup_export_confirm_password);
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_generate }));
  expect(password.value).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{24}$/);
  expect(confirmation).toHaveValue(password.value);
  expect(password).toHaveAttribute("type", "password");
  expect(confirmation).toHaveAttribute("type", "password");
  fireEvent.click(screen.getAllByRole("button", { name: settings.backup_export_show })[0]);
  expect(password).toHaveAttribute("type", "text");
  expect(confirmation).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_hide }));
  expect(password).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_copy }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(password.value));
  expect(exportBackup).not.toHaveBeenCalled();
});

it("makes plaintext a deliberate choice with a warning and an explicit button", async () => {
  render(<BackupExportDialog filename="selected.db" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: settings.backup_export_plain }));
  expect(screen.getByText(settings.backup_export_plain_warning)).toBeVisible();
  expect(screen.queryByLabelText(settings.backup_export_password)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_plain_button }));
  await waitFor(() =>
    expect(exportBackup).toHaveBeenCalledWith("selected.db", null, true, expect.any(AbortSignal)),
  );
});

it("clears password fields after a failed export", async () => {
  exportBackup.mockRejectedValueOnce(new Error("Use HTTPS to export a password-protected backup."));
  render(<BackupExportDialog filename="selected.db" onClose={vi.fn()} />);
  for (const label of [settings.backup_export_password, settings.backup_export_confirm_password]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: "long enough password" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await screen.findByText(settings.backup_action_failed);
  const details = screen.getByText("Use HTTPS to export a password-protected backup.");
  expect(details.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText(settings.recovery_details));
  expect(details.closest("details")).toHaveAttribute("open");
  expect(screen.getByLabelText(settings.backup_export_password)).toHaveValue("");
  expect(screen.getByLabelText(settings.backup_export_confirm_password)).toHaveValue("");
});

it("aborts an in-flight export when cancelled", async () => {
  let finish!: (saved: boolean) => void;
  exportBackup.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const onClose = vi.fn();
  render(<BackupExportDialog filename="selected.db" onClose={onClose} />);
  fireEvent.click(screen.getByRole("radio", { name: settings.backup_export_plain }));
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_plain_button }));
  const signal = exportBackup.mock.calls[0][3] as AbortSignal;
  expect(signal.aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(signal.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => finish(false));
});

it("falls back cleanly when an error has no readable details", async () => {
  exportBackup.mockRejectedValueOnce({ status: 500 });
  render(<BackupExportDialog filename="selected.db" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: settings.backup_export_plain }));
  fireEvent.click(screen.getByRole("button", { name: settings.backup_export_plain_button }));
  await screen.findByText(settings.backup_action_failed);
  expect(screen.queryByText(settings.recovery_details)).not.toBeInTheDocument();
  expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
});
