import { fireEvent, render, screen } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { SUPPORTED_LOCALE_CODES } from "@/i18n/locales";
import copy from "@/i18n/locales/en/settings.json";
import { BackupRestoreForm } from "./backup-restore-form";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  loading: false,
  error: false,
  removing: false,
  web: true,
  data: [
    {
      filename: "old.db",
      sizeBytes: 4096,
      modifiedAt: "2026-09-01T12:00:00Z",
      protection: "encrypted",
      reason: "manual",
    },
  ],
}));
vi.mock("@/adapters", () => ({
  get isWeb() {
    return mocks.web;
  },
  openDatabaseBackupFolder: vi.fn(),
  getDatabaseBackupDownloadUrl: (filename: string) => `/backups/${filename}/download`,
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ platform: { is_desktop: false } }),
}));
vi.mock("./use-backup-restore", () => ({
  useBackupRestore: () => ({
    backups: {
      data: mocks.data,
      isPending: mocks.loading,
      isError: mocks.error,
      refetch: mocks.retry,
    },
    create: { mutate: mocks.create, isPending: false },
    remove: { mutate: mocks.remove, isPending: mocks.removing },
  }),
}));
vi.mock("./backup-export-dialog", () => ({
  BackupExportDialog: ({ filename }: { filename: string }) => <p>Exporting {filename}</p>,
}));
vi.mock("./backup-import-dialog", () => ({
  BackupImportDialog: ({ filename }: { filename?: string }) => (
    <p>Inspecting {filename || "picked file"}</p>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.removing = false;
  mocks.loading = false;
  mocks.error = false;
  mocks.web = true;
  mocks.data = [
    {
      filename: "old.db",
      sizeBytes: 4096,
      modifiedAt: "2026-09-01T12:00:00Z",
      protection: "encrypted",
      reason: "manual",
    },
  ];
});
it("shows actual snapshot protection and exports the selected snapshot", () => {
  render(<BackupRestoreForm />);
  expect(screen.getByText(new RegExp(copy.backup_protection_encrypted))).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Export Backup from Sep 1, 2026/ }));
  expect(screen.getByText("Exporting old.db")).toBeVisible();
});
it("native opens review for saved snapshots and disables unavailable snapshots", () => {
  mocks.web = false;
  mocks.data.push({
    ...mocks.data[0],
    filename: "unknown.db",
    modifiedAt: "2026-09-02T12:00:00Z",
    protection: "unavailable",
  });
  render(<BackupRestoreForm />);
  expect(screen.getByRole("button", { name: /^Restore Backup from Sep 2, 2026/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Export Backup from Sep 2, 2026/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Delete Backup from Sep 2, 2026/ })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /^Restore Backup from Sep 1, 2026/ }));
  expect(screen.getByText("Inspecting old.db")).toBeVisible();
});
it("native offers file restore alongside managed creation", () => {
  mocks.web = false;
  render(<BackupRestoreForm />);
  fireEvent.click(screen.getByRole("button", { name: copy.backup_now }));
  expect(mocks.create).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: copy.backup_restore_from_file }));
  expect(screen.getByText("Inspecting picked file")).toBeVisible();
});
it("shows list failure and retry instead of an empty success state", () => {
  mocks.error = true;
  render(<BackupRestoreForm />);
  expect(screen.getByRole("alert")).toHaveTextContent(copy.backup_action_failed);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.retry).toHaveBeenCalled();
});

it("keeps original server snapshots behind an explicit key warning, including unavailable keys", () => {
  mocks.data[0].protection = "unavailable";
  render(<BackupRestoreForm />);
  expect(screen.getByRole("link", { name: copy.backup_original_save })).not.toBeVisible();
  fireEvent.click(screen.getByText(copy.backup_original_advanced));
  expect(screen.getByText(copy.backup_original_warning)).toBeVisible();
  expect(screen.getByRole("link", { name: copy.backup_original_save })).toHaveAttribute(
    "href",
    "/backups/old.db/download",
  );
});

it("does not offer a server snapshot URL on native", () => {
  mocks.web = false;
  render(<BackupRestoreForm />);
  expect(screen.queryByText(copy.backup_original_advanced)).not.toBeInTheDocument();
});

it("web offers backup management without any restore controls", () => {
  render(<BackupRestoreForm />);
  expect(
    screen.queryByRole("button", { name: copy.backup_restore_from_file }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Restore Backup from Sep 1, 2026/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Export Backup from Sep 1, 2026/ })).toBeEnabled();
  expect(screen.getByRole("button", { name: /^Delete Backup from Sep 1, 2026/ })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: copy.backup_now }));
  expect(mocks.create).toHaveBeenCalled();
});

const catalogs = import.meta.glob<Record<string, string>>(
  "../../../i18n/locales/*/{common,settings}.json",
  {
    eager: true,
    import: "default",
  },
);

it.each(SUPPORTED_LOCALE_CODES)(
  "localizes delete confirmation and pending copy in %s",
  async (locale) => {
    const common = catalogs[`../../../i18n/locales/${locale}/common.json`];
    const settings = catalogs[`../../../i18n/locales/${locale}/settings.json`];
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      resources: { [locale]: { common, settings } },
      interpolation: { escapeValue: false },
    });
    const view = () => (
      <I18nextProvider i18n={i18n}>
        <BackupRestoreForm />
      </I18nextProvider>
    );
    const { rerender } = render(view());
    fireEvent.click(screen.getByTitle(common.delete));
    expect(screen.getByRole("button", { name: common.cancel })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: common.delete }));
    expect(mocks.remove).toHaveBeenCalledWith("old.db");
    mocks.removing = true;
    rerender(view());
    expect(screen.getByRole("button", { name: settings.backup_deleting })).toBeDisabled();
  },
);
