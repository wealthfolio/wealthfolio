import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/settings.json";
import { BackupImportDialog } from "./backup-import-dialog";
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  saved: vi.fn(),
  discard: vi.fn(),
  confirm: vi.fn(),
  encryption: vi.fn(),
  reload: vi.fn(),
  choose: vi.fn(),
}));
vi.mock("@/adapters", () => ({
  inspectDatabaseBackup: mocks.inspect,
  inspectSavedDatabaseBackup: mocks.saved,
  discardDatabaseBackupImport: mocks.discard,
  restoreDatabaseBackupImport: mocks.confirm,
  getDatabaseEncryptionStatus: mocks.encryption,
  openDatabaseFileDialog: mocks.choose,
}));
vi.mock("@/lib/reload-application", () => ({ reloadApplication: mocks.reload }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.choose.mockResolvedValue("/backups/backup.wfbackup");
  const preview = {
    id: "immutable-id",
    summary: { accountCount: 2, activityCount: 15, createdAt: null },
  };
  mocks.saved.mockResolvedValue(preview);
  mocks.inspect.mockResolvedValue(preview);
  mocks.encryption.mockResolvedValue({ enabled: true, supported: false });
  mocks.discard.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(undefined);
});
function mount(filename?: string) {
  const close = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BackupImportDialog filename={filename} onClose={close} />
    </QueryClientProvider>,
  );
  return { ...view, close, client };
}
it("validates the selected snapshot before confirming its immutable ID once", async () => {
  mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  expect(mocks.confirm).not.toHaveBeenCalled();
  const confirm = await screen.findByRole("button", { name: copy.backup_confirm_restore });
  expect(mocks.saved).toHaveBeenCalledWith("old.db", expect.any(AbortSignal));
  expect(screen.getByText(copy.backup_import_confirmation)).toBeVisible();
  expect(screen.getByText(copy.backup_destination_encrypted)).toBeVisible();
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.confirm).toHaveBeenCalledWith("immutable-id");
  await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
});
it("discards an unconfirmed preview on unmount", async () => {
  const view = mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_confirm_restore });
  view.unmount();
  expect(mocks.discard).toHaveBeenCalledWith("immutable-id");
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("explains a failed backup check without offering restore", async () => {
  mocks.saved.mockRejectedValueOnce(new Error("SQLCipher failure"));
  mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.backup_action_failed);
  expect(screen.getByText("SQLCipher failure").closest("details")).not.toHaveAttribute("open");
  expect(
    screen.queryByRole("button", { name: copy.backup_confirm_restore }),
  ).not.toBeInTheDocument();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("inspects the native selected file and preserves exact password whitespace", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_choose_file }));
  await screen.findByText("backup.wfbackup");
  fireEvent.change(screen.getByLabelText(copy.recovery_password), {
    target: { value: "  exact password  " },
  });
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_confirm_restore });
  expect(mocks.inspect).toHaveBeenCalledWith(
    "/backups/backup.wfbackup",
    "  exact password  ",
    expect.any(AbortSignal),
  );
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it("preserves native restore instructions and requires inspection again after failure", async () => {
  const reason = "This backup preview has expired. Inspect the backup again before restoring.";
  mocks.confirm.mockRejectedValueOnce(reason);
  mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  fireEvent.click(await screen.findByRole("button", { name: copy.backup_confirm_restore }));
  const details = await screen.findByText(reason);
  expect(details.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText(copy.recovery_details));
  expect(details.closest("details")).toHaveAttribute("open");
  expect(
    screen.queryByRole("button", { name: copy.backup_confirm_restore }),
  ).not.toBeInTheDocument();
  expect(mocks.reload).not.toHaveBeenCalled();
});
