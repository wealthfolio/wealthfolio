import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { act, render, screen, fireEvent, renderHook, waitFor } from "@/test/render";
import copy from "@/i18n/locales/en/settings.json";
import { QueryKeys } from "@/lib/query-keys";
import { useBackupRestore } from "./use-backup-restore";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/adapters", () => ({
  backupDatabase: mocks.create,
  listDatabaseBackups: mocks.list,
  deleteDatabaseBackup: mocks.remove,
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ filename: "saved.db" });
  mocks.remove.mockResolvedValue(undefined);
});
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return renderHook(useBackupRestore, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}
it("lists managed snapshots and refreshes them after creation and deletion", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.backups.isSuccess).toBe(true));
  await act(() => result.current.create.mutateAsync());
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  await act(() => result.current.remove.mutateAsync("saved.db"));
  expect(mocks.remove).toHaveBeenCalledWith("saved.db", expect.anything());
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
});
it("reports failures without a success message", async () => {
  mocks.create.mockRejectedValue(new Error("Disk full"));
  const { result } = mount();
  await act(async () => {
    await result.current.create.mutateAsync().catch(() => undefined);
  });
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  render(mocks.toast.mock.calls[0][0].description);
  expect(screen.getByText(copy.backup_action_failed)).toBeInTheDocument();
  expect(screen.getByText("Disk full").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText(copy.recovery_details));
  expect(screen.getByText("Disk full").closest("details")).toHaveAttribute("open");
});

it("refreshes a fresh cached list when reopening after a sync backup", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData([QueryKeys.DATABASE_BACKUPS], []);
  const snapshots = [{ filename: "sync-backup.db" }];
  mocks.list.mockResolvedValue(snapshots);
  const { result } = mount(client);
  await waitFor(() => expect(result.current.backups.data).toEqual(snapshots));
  expect(mocks.list).toHaveBeenCalledTimes(1);
});
