import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), mutation: vi.fn() }));
vi.mock("@/adapters", () => ({
  isWeb: false,
  logger: { error: vi.fn() },
  listDatabaseBackups: vi.fn(),
  deleteDatabaseBackup: vi.fn(),
  getDatabaseBackupDownloadUrl: vi.fn(),
}));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ platform: { is_mobile: true } }) }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: mocks.mutation,
  useQuery: () => ({}),
  useQueryClient: () => ({}),
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));

import { useBackupRestore } from "./use-backup-restore";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

it.each([
  ["Backup file not found", "Backup file not found"],
  [new Error("Invalid SQLite database"), "Invalid SQLite database"],
  [{ message: "Permission denied" }, "Permission denied"],
  [{ code: 1 }, "An unknown error occurred"],
  ["", "An unknown error occurred"],
])("shows the native restore error in the toast: %s", (error, message) => {
  useBackupRestore();
  const restoreOptions = mocks.mutation.mock.calls[2][0];
  restoreOptions.onError(error);
  expect(mocks.toast).toHaveBeenCalledWith({
    title: "Restore failed",
    description: message,
    variant: "destructive",
  });
});
