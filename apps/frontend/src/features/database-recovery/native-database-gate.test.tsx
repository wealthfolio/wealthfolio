import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/settings.json";
import { NativeDatabaseGate } from "./native-database-gate";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  choose: vi.fn(),
  inspect: vi.fn(),
  discard: vi.fn(),
  recover: vi.fn(),
  retry: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("@/lib/reload-application", () => ({ reloadApplication: mocks.reload }));
vi.mock("@/adapters", () => ({ isWeb: false }));
vi.mock("../../adapters/tauri/files", () => ({ openDatabaseFileDialog: mocks.choose }));
vi.mock("../../adapters/tauri/settings", () => ({
  getDatabaseStartupStatus: mocks.status,
  inspectDatabaseBackup: mocks.inspect,
  discardDatabaseBackupImport: mocks.discard,
  recoverDatabaseFromImport: mocks.recover,
  retryDatabaseStartup: mocks.retry,
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue({ ready: false, error: "Missing device key", canRecover: true });
  mocks.choose.mockResolvedValue("/backup.wfbackup");
  mocks.inspect.mockResolvedValue({
    id: "validated",
    summary: { accountCount: 2, activityCount: 15, createdAt: null },
  });
  mocks.discard.mockResolvedValue(undefined);
  mocks.recover.mockResolvedValue(undefined);
});
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NativeDatabaseGate>
        <p>Portfolio mounted</p>
      </NativeDatabaseGate>
    </QueryClientProvider>,
  );
}
it("renders the opening screen during migration and mounts providers after readiness", async () => {
  mocks.status
    .mockResolvedValueOnce({ ready: false, error: null, canRecover: false })
    .mockResolvedValue({ ready: true, error: null, canRecover: false });
  mount();
  await waitFor(() => expect(mocks.status).toHaveBeenCalledOnce());
  expect(screen.getByRole("status")).toHaveTextContent(copy.recovery_opening);
  expect(screen.queryByText("Portfolio mounted")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.recovery_retry })).not.toBeInTheDocument();
  await screen.findByText("Portfolio mounted");
});

it("shows a failed upgrade with its retained backup location", async () => {
  const error = "Migration failed. Pre-migration backup retained at /backups/original.db";
  mocks.status.mockResolvedValue({ ready: false, error, canRecover: true });
  mount();
  await screen.findByText(error);
  expect(screen.queryByText("Portfolio mounted")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: copy.recovery_retry })).toBeInTheDocument();
});

it("keeps portfolio providers unmounted until startup succeeds", async () => {
  mocks.status.mockResolvedValue({ ready: true, error: null, canRecover: false });
  mount();
  await screen.findByText("Portfolio mounted");
});
it("requires validation and explicit confirmation before recovery", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.recovery_choose_file }));
  await screen.findByText("backup.wfbackup");
  fireEvent.change(screen.getByLabelText(copy.recovery_password), {
    target: { value: "  pasted backup password  " },
  });
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  await screen.findByRole("region", { name: copy.recovery_preview });
  expect(mocks.inspect).toHaveBeenCalledWith(
    "/backup.wfbackup",
    "  pasted backup password  ",
    expect.any(AbortSignal),
  );
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(screen.queryByText("Portfolio mounted")).not.toBeInTheDocument();
  mocks.status.mockResolvedValue({ ready: true, error: null, canRecover: false });
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_restore }));
  await screen.findByText("Portfolio mounted");
  expect(mocks.recover).toHaveBeenCalledWith("validated");
});
it("discards a preview on Back and clears password state", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.recovery_choose_file }));
  await screen.findByText("backup.wfbackup");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  fireEvent.click(await screen.findByRole("button", { name: copy.recovery_back }));
  await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith("validated"));
  expect(screen.getByLabelText(copy.recovery_password)).toHaveValue("");
  expect(mocks.recover).not.toHaveBeenCalled();
});
it("does not offer recovery without database ownership", async () => {
  mocks.status.mockResolvedValue({
    ready: false,
    error: "Another process owns this database",
    canRecover: false,
  });
  mount();
  await screen.findByText(copy.recovery_unavailable);
  expect(screen.queryByRole("button", { name: copy.recovery_choose_file })).not.toBeInTheDocument();
});
it("aborts inspection when the recovery view unmounts", async () => {
  mocks.inspect.mockImplementation(
    (_path: string, _password: string, signal: AbortSignal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.recovery_choose_file }));
  await screen.findByText("backup.wfbackup");
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_inspect }));
  view.unmount();
  expect(mocks.inspect.mock.calls[0][2].aborted).toBe(true);
});

it("retries failed startup before allowing the portfolio to mount", async () => {
  mount();
  await screen.findByText(copy.recovery_title);
  mocks.retry.mockImplementation(async () => {
    mocks.status.mockResolvedValue({ ready: true, error: null, canRecover: false });
  });
  fireEvent.click(screen.getByRole("button", { name: copy.recovery_retry }));
  await screen.findByText("Portfolio mounted");
  expect(mocks.retry).toHaveBeenCalledOnce();
});

it("observes an owned recovery after the webview reloads", async () => {
  mocks.status
    .mockResolvedValueOnce({
      ready: false,
      maintenance: true,
      error: "Previous startup error",
      canRecover: false,
    })
    .mockResolvedValue({ ready: true, maintenance: false, error: null, canRecover: false });
  mount();
  await waitFor(() => expect(mocks.status).toHaveBeenCalledOnce());
  expect(screen.getByRole("status")).toHaveTextContent(copy.recovery_opening);
  expect(screen.queryByRole("button", { name: copy.recovery_retry })).not.toBeInTheDocument();
  await screen.findByText("Portfolio mounted");
});

it("waits for a fresh status and reloads when a cached native generation was replaced", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["database-startup"], { ready: true, maintenance: false, generation: "old" });
  mocks.status.mockResolvedValue({ ready: true, maintenance: false, generation: "new" });
  render(
    <QueryClientProvider client={client}>
      <NativeDatabaseGate>
        <p>Stale providers</p>
      </NativeDatabaseGate>
    </QueryClientProvider>,
  );
  expect(screen.queryByText("Stale providers")).not.toBeInTheDocument();
  await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Stale providers")).not.toBeInTheDocument();
});
