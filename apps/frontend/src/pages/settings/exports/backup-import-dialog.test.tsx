import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "react";
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
  vi.mocked(window.matchMedia).mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
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
function mount(
  filename?: string,
  cloud = false,
  reactStrictMode = false,
  onRetry?: () => Promise<void>,
) {
  const close = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BackupImportDialog
        filename={filename}
        onClose={close}
        onRetry={onRetry}
        displayName={cloud ? "Selected cloud backup" : undefined}
        initialPreview={
          cloud
            ? {
                id: "cloud-immutable-id",
                summary: { accountCount: 2, activityCount: 15, createdAt: null, appVersion: null },
              }
            : undefined
        }
      />
    </QueryClientProvider>,
    { reactStrictMode },
  );
  return { ...view, close, client };
}
it("keeps cloud previews immutable with no local file picker or back-to-file step", async () => {
  const view = mount(undefined, true);
  expect(screen.getByText("Selected cloud backup")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.recovery_choose_file })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.recovery_change_file })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: copy.backup_restore_title })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.close).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(mocks.discard).toHaveBeenCalledWith("cloud-immutable-id");
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(mocks.inspect).not.toHaveBeenCalled();
});
it("keeps a cloud preview through the development StrictMode remount", async () => {
  mount(undefined, true, true);
  const restore = screen.getByRole("button", { name: copy.backup_restore_title });
  await waitFor(() => expect(restore).toBeEnabled());
  expect(mocks.discard).not.toHaveBeenCalled();
  fireEvent.click(restore);
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith("cloud-immutable-id"));
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("does not reuse a consumed cloud preview after restore failure", async () => {
  mocks.confirm.mockRejectedValueOnce(new Error("Expired backup preview"));
  const view = mount(undefined, true);
  const restore = screen.getByRole("button", { name: copy.backup_restore_title });
  await waitFor(() => expect(restore).toBeEnabled());
  fireEvent.click(restore);
  await screen.findByRole("alert");
  expect(restore).toBeDisabled();
  expect(screen.getByText("Selected cloud backup")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.recovery_choose_file })).not.toBeInTheDocument();
  fireEvent.click(restore);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.confirm).toHaveBeenCalledWith("cloud-immutable-id");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(view.close).toHaveBeenCalledTimes(1);
});
it("offers to check a used cloud preview again instead of a disabled restore", async () => {
  mocks.confirm.mockRejectedValueOnce(
    new Error("This backup preview has expired or is unavailable"),
  );
  const retry = vi.fn().mockResolvedValue(undefined);
  mount(undefined, true, false, retry);
  const restore = screen.getByRole("button", { name: copy.backup_restore_title });
  await waitFor(() => expect(restore).toBeEnabled());
  fireEvent.click(restore);
  await screen.findByRole("alert");
  const again = screen.getByRole("button", { name: "Retry" });
  expect(again).toBeEnabled();
  fireEvent.click(again);
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
});
it("validates the selected snapshot before confirming its immutable ID once", async () => {
  mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  expect(mocks.confirm).not.toHaveBeenCalled();
  const confirm = await screen.findByRole("button", { name: copy.backup_restore_title });
  expect(mocks.saved).toHaveBeenCalledWith("old.db", expect.any(AbortSignal));
  // The restore step fades in from opacity 0; wait for it on slow runners.
  await waitFor(() => expect(screen.getByText(copy.backup_replace_warning)).toBeVisible());
  expect(screen.getByText(copy.backup_destination_encrypted)).toBeVisible();
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.confirm).toHaveBeenCalledWith("immutable-id");
  expect(await screen.findByRole("status")).toHaveTextContent(copy.backup_restore_success_help);
  expect(mocks.reload).not.toHaveBeenCalled();
  await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1), { timeout: 2000 });
});
it("discards an unconfirmed preview on unmount", async () => {
  const view = mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_restore_title });
  view.unmount();
  expect(mocks.discard).toHaveBeenCalledWith("immutable-id");
  expect(mocks.confirm).not.toHaveBeenCalled();
});
// A phone screen kept under another one is a hidden <Activity>: its effects
// clean up while it is out of sight, and run again when it is shown.
function mountKept() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  const view = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <Activity mode={hidden ? "hidden" : "visible"}>
        <BackupImportDialog filename="old.db" onClose={close} />
      </Activity>
    </QueryClientProvider>
  );
  const rendered = render(view(false));
  return {
    hide: () => rendered.rerender(view(true)),
    show: () => rendered.rerender(view(false)),
    // The stack keeps only a few screens: older hidden ones are dropped unseen.
    drop: () => rendered.rerender(<QueryClientProvider client={client} />),
  };
}
it("keeps an inspected backup to restore when its phone screen is shown again", async () => {
  const kept = mountKept();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  const restore = await screen.findByRole("button", { name: copy.backup_restore_title });
  await waitFor(() => expect(restore).toBeEnabled());

  kept.hide();
  kept.show();

  expect(mocks.discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: copy.backup_restore_title }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith("immutable-id"));
});
it("finishes a backup check that ends while its phone screen is hidden", async () => {
  let finish: () => void = () => undefined;
  mocks.saved.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () =>
        resolve({ id: "immutable-id", summary: { accountCount: 2, activityCount: 15 } });
    }),
  );
  const kept = mountKept();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await waitFor(() => expect(mocks.saved).toHaveBeenCalledOnce());

  kept.hide();
  act(() => finish());
  kept.show();

  expect(await screen.findByRole("button", { name: copy.backup_restore_title })).toBeVisible();
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("discards an inspected backup when its hidden phone screen is dropped", async () => {
  const kept = mountKept();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_restore_title });

  kept.hide();
  expect(mocks.discard).not.toHaveBeenCalled();
  kept.drop();

  await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith("immutable-id"));
});
it("stops a backup check when its hidden phone screen is dropped", async () => {
  mocks.saved.mockReturnValueOnce(
    new Promise(() => {
      /* Keep the check running. */
    }),
  );
  const kept = mountKept();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await waitFor(() => expect(mocks.saved).toHaveBeenCalledOnce());
  const signal = mocks.saved.mock.calls[0][1] as AbortSignal;

  kept.hide();
  expect(signal.aborted).toBe(false);
  kept.drop();

  await waitFor(() => expect(signal.aborted).toBe(true));
});
it("explains a failed backup check without offering restore", async () => {
  mocks.saved.mockRejectedValueOnce(new Error("SQLCipher failure"));
  mount("old.db");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.backup_action_failed);
  expect(screen.getByText("SQLCipher failure").closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByRole("button", { name: copy.backup_restore_title })).not.toBeInTheDocument();
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
  await screen.findByRole("button", { name: copy.backup_restore_title });
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
  fireEvent.click(await screen.findByRole("button", { name: copy.backup_restore_title }));
  const details = await screen.findByText(reason);
  expect(details.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText(copy.recovery_details));
  expect(details.closest("details")).toHaveAttribute("open");
  expect(screen.queryByRole("button", { name: copy.backup_restore_title })).not.toBeInTheDocument();
  expect(mocks.reload).not.toHaveBeenCalled();
});

it("returns within the sheet and discards the old preview before checking again", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_choose_file }));
  await screen.findByText("backup.wfbackup");
  fireEvent.change(screen.getByLabelText(copy.recovery_password), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_restore_title });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(mocks.discard).toHaveBeenCalledWith("immutable-id");
  await waitFor(() => expect(screen.getByText("backup.wfbackup")).toBeVisible());
  expect(screen.getByLabelText(copy.recovery_password)).toHaveValue("");
  expect(screen.queryByRole("button", { name: copy.backup_restore_title })).not.toBeInTheDocument();
  expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("button", { name: copy.backup_restore_title });
  expect(mocks.inspect).toHaveBeenCalledTimes(2);
});

it("keeps the mobile sheet open and blocks navigation while restoring", async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  mocks.confirm.mockReturnValue(
    new Promise(() => {
      /* Keep the restore in flight. */
    }),
  );
  try {
    const view = mount("old.db");
    fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
    fireEvent.click(await screen.findByRole("button", { name: copy.backup_restore_title }));
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(view.close).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  }
});
it("wraps the explanation and truncates only a backup name", () => {
  const local = mount("/backups/backup.wfbackup");
  expect(screen.getByText(copy.backup_import_description)).not.toHaveClass("truncate");
  local.unmount();
  mount(undefined, true);
  expect(screen.getByText("Selected cloud backup")).toHaveClass("truncate");
});
