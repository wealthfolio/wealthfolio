import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { CloudBackupOperation } from "@/adapters";
import copy from "@/i18n/locales/en/settings.json";
import { CloudBackupCard, CloudBackupSummary } from "./cloud-backup-card";
const mocks = vi.hoisted(() => ({
  action: vi.fn<(op: CloudBackupOperation) => Promise<unknown>>(),
  capture: vi.fn(),
  download: vi.fn(),
  preview: vi.fn(),
  profile: "profile-a",
  user: "user-a",
  connected: true,
  desktop: true,
  mobile: false,
}));
vi.mock("@/adapters", () => ({
  cloudBackupAction: mocks.action,
  captureCloudBackup: mocks.capture,
  downloadCloudBackup: mocks.download,
  previewCloudBackupRestore: mocks.preview,
  get isDesktop() {
    return mocks.desktop;
  },
}));
vi.mock("@/features/wealthfolio-connect/providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => ({
    isEnabled: true,
    isConnected: mocks.connected,
    user: { id: mocks.user },
  }),
}));
vi.mock("@/features/profiles/profile-context", () => ({
  useProfile: () => ({ profile: { id: mocks.profile } }),
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMobile: mocks.mobile, loading: false }),
}));
vi.mock("./backup-import-dialog", () => ({
  BackupImportDialog: () => <div>Immutable restore preview</div>,
}));
const status = {
  hasKey: false,
  keyReady: false,
  isSource: false,
  policy: { enabled: false, uploadEntitled: true, lastBackupAt: null, nextDueAt: null },
  history: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.profile = "profile-a";
  mocks.user = "user-a";
  mocks.connected = true;
  mocks.desktop = true;
  mocks.mobile = false;
  mocks.action.mockResolvedValue(status);
});
function mount(summary = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{summary ? <CloudBackupSummary /> : <CloudBackupCard />}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(element()), element, client };
}
it("offers recovery for a locked current source before its first successful backup", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    isSource: true,
    policy: { ...status.policy, enabled: true },
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_unlock }));
  expect(screen.getByRole("dialog")).toHaveTextContent(copy.cloud_backup_unlock_description);
  expect(screen.queryByRole("button", { name: copy.cloud_backup_retry })).not.toBeInTheDocument();
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("requires fresh local source consent after restore instead of claiming daily protection", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    isSource: true,
    sourceConsented: false,
    policy: {
      ...status.policy,
      enabled: true,
      lastBackupAt: "2026-10-01T00:00:00Z",
    },
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_resume }));
  expect(screen.queryByText(copy.cloud_backup_state_on)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: copy.cloud_backup_enable })).toBeDisabled();
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("qualifies server restore instructions with the active profile and leaves confirmation enabled", async () => {
  mocks.desktop = false;
  mocks.profile = "b802879e-2a71-48d9-baea-f0b094b3946c";
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    history: [{ backupId: "saved", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_restore_help }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent(`--profile ${mocks.profile}`);
  expect(dialog).not.toHaveTextContent("--yes");
});
it("status and recovery setup never send the database before explicit source consent", async () => {
  let ready = false;
  mocks.action.mockImplementation((op) => {
    if (op.action === "setup") {
      ready = true;
      return Promise.resolve({ recoveryCode: "WFREC1-synthetic-code" });
    }
    return Promise.resolve({ ...status, hasKey: ready, keyReady: ready });
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_setup }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("WFREC1-synthetic-code");
  const enable = await screen.findByRole("button", { name: copy.cloud_backup_enable });
  expect(enable).toBeDisabled();
  expect(mocks.capture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(enable);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith({ action: "enable", confirmed: true }),
  );
  expect(mocks.capture).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("never reuses backup history or recovery-code display across profiles", async () => {
  mocks.action.mockImplementation((op) =>
    Promise.resolve(op.action === "setup" ? { recoveryCode: "WFREC1-private-profile-a" } : status),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_setup }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("WFREC1-private-profile-a");
  mocks.profile = "profile-b";
  view.rerender(view.element());
  await waitFor(() =>
    expect(screen.queryByText("WFREC1-private-profile-a")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(mocks.action.mock.calls.filter(([op]) => op.action === "status")).toHaveLength(3),
  );
  expect(view.client.getQueryData(["cloud-backups", "profile-b:user-a"])).toEqual(status);
});
it("old cloud servers leave local workflows available without capture", async () => {
  mocks.action.mockRejectedValue(new Error("BACKUPS_UNAVAILABLE"));
  mount();
  await screen.findByText(copy.cloud_backup_unavailable);
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: copy.cloud_backup_enable })).not.toBeInTheDocument();
});
it("cloud delete keeps failure feedback inside its confirmation and clears it on dismissal", async () => {
  mocks.action.mockImplementation((op) => {
    if (op.action === "delete") return Promise.reject(new Error("Backup deletion failed"));
    return Promise.resolve({
      ...status,
      hasKey: true,
      keyReady: true,
      history: [{ backupId: "point", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
    });
  });
  mount();
  fireEvent.pointerDown(await screen.findByRole("button", { name: copy.cloud_backup_options }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: copy.cloud_backup_delete_all }));
  expect(mocks.action.mock.calls.some(([op]) => op.action === "delete")).toBe(false);
  await screen.findByText(copy.cloud_backup_delete_confirm);
  fireEvent.click(screen.getAllByRole("button", { name: copy.cloud_backup_delete }).at(-1)!);
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.cloud_backup_failed);
  expect(screen.getAllByText(copy.cloud_backup_failed)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(copy.cloud_backup_failed)).not.toBeInTheDocument();
});

it("deletes cloud history only after confirmation without requiring another sign-in", async () => {
  let deleted = false;
  mocks.action.mockImplementation((op) => {
    if (op.action === "delete") {
      deleted = true;
      return Promise.resolve({ deleted: 1 });
    }
    return Promise.resolve({
      ...status,
      hasKey: true,
      keyReady: true,
      history: deleted
        ? []
        : [{ backupId: "point", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
    });
  });
  mount();
  fireEvent.pointerDown(await screen.findByRole("button", { name: copy.cloud_backup_options }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: copy.cloud_backup_delete_all }));
  expect(mocks.action.mock.calls.some(([op]) => op.action === "delete")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_delete }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith({ action: "delete", backupId: null }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByText(copy.cloud_backup_reauth)).not.toBeInTheDocument();
});

it("mobile exposes explicit backup activation with foreground requirements", async () => {
  mocks.mobile = true;
  mocks.action.mockResolvedValue({ ...status, hasKey: true, keyReady: true });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_resume }));
  expect(screen.getByRole("dialog")).toHaveTextContent(
    copy.cloud_backup_resume_description_mobile.replace("{{name}}", copy.cloud_backup_this_profile),
  );
  expect(mocks.capture).not.toHaveBeenCalled();
  const enable = screen.getByRole("button", { name: copy.cloud_backup_enable });
  expect(enable).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(enable);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith({ action: "enable", confirmed: true }),
  );
  expect(mocks.capture).not.toHaveBeenCalled();
});

it("mobile offers recovery-package downloads while replacement remains gated", async () => {
  mocks.mobile = true;
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    history: [{ backupId: "mobile-point", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_download }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledWith("mobile-point"));
  expect(screen.queryByRole("button", { name: copy.cloud_backup_restore })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: copy.cloud_backup_restore_help }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(copy.cloud_backup_mobile_restore)).toBeInTheDocument();
});

it("discards a delayed setup response after changing profiles", async () => {
  let complete!: (value: { recoveryCode: string }) => void;
  mocks.action.mockImplementation((op) =>
    op.action === "setup"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(status),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_setup }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  mocks.profile = "profile-b";
  view.rerender(view.element());
  complete({ recoveryCode: "WFREC1-delayed-profile-a" });
  await waitFor(() =>
    expect(view.client.getQueryData(["cloud-backups", "profile-b:user-a"])).toEqual(status),
  );
  expect(screen.queryByText("WFREC1-delayed-profile-a")).not.toBeInTheDocument();
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("does not start capture when an enable response arrives after changing profiles", async () => {
  let complete!: (value: object) => void;
  mocks.action.mockImplementation((op) =>
    op.action === "enable"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Promise.resolve({ ...status, hasKey: true, keyReady: true }),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_resume }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_enable }));
  mocks.profile = "profile-b";
  view.rerender(view.element());
  complete({});
  await screen.findByRole("button", { name: copy.cloud_backup_resume });
  expect(mocks.capture).not.toHaveBeenCalled();
});

it("keeps the new-user view simple and opens setup before creating any key", async () => {
  mount();
  await screen.findByRole("button", { name: copy.cloud_backup_setup });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_setup }));
  expect(await screen.findByRole("dialog")).toHaveTextContent(copy.cloud_backup_exclusions);
  expect(mocks.action.mock.calls.every(([op]) => op.action === "status")).toBe(true);
});
it("Connect shows real backup status and links to management without uploading", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    history: [{ backupId: "point", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
    policy: { ...status.policy, enabled: false, lastBackupAt: "2026-10-01T00:00:00Z" },
  });
  mount(true);
  await screen.findAllByText(copy.cloud_backup_state_paused);
  expect(screen.getByRole("link", { name: copy.cloud_backup_manage })).toHaveAttribute(
    "href",
    "/settings/exports",
  );
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("keeps automatic backups paused until the user enables the source", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    isSource: true,
    policy: { ...status.policy, enabled: false },
  });
  mount();
  expect((await screen.findAllByText(copy.cloud_backup_state_paused)).length).toBeGreaterThan(0);
  expect(screen.queryByText(copy.cloud_backup_state_on)).not.toBeInTheDocument();
});
it("explains source handoff before opting into uploads on another device", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    policy: { ...status.policy, enabled: true },
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_resume }));
  expect(screen.getByRole("dialog")).toHaveTextContent("This replaces your other backup device");
  expect(screen.getByRole("button", { name: copy.cloud_backup_enable })).toBeDisabled();
  expect(mocks.capture).not.toHaveBeenCalled();
});
it("hides cloud access when signed out without making a status request", () => {
  mocks.connected = false;
  mount(true);
  expect(mocks.action).not.toHaveBeenCalled();
  expect(screen.queryByText(copy.cloud_backup_title)).not.toBeInTheDocument();
});

it("offers Connect to signed-out users without fetching private backup status", () => {
  mocks.connected = false;
  mount();
  expect(screen.getByText(copy.cloud_backup_promotion_title)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: copy.cloud_backup_promotion_action })).toHaveAttribute(
    "href",
    "/settings/connect",
  );
  expect(mocks.action).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: copy.cloud_backup_setup })).not.toBeInTheDocument();
});

it("shows a subscription promotion instead of setup controls to non-subscribers", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    policy: { ...status.policy, uploadEntitled: false },
  });
  mount();
  await screen.findByText(copy.cloud_backup_promotion_title);
  expect(screen.queryByText(copy.cloud_backup_history)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy.cloud_backup_setup })).not.toBeInTheDocument();
  expect(mocks.capture).not.toHaveBeenCalled();
});

it("keeps expired subscribers' saved copies recoverable without allowing new uploads", async () => {
  mocks.action.mockImplementation((op) =>
    Promise.resolve(
      op.action === "recover"
        ? {}
        : {
            ...status,
            hasKey: true,
            keyReady: false,
            policy: { ...status.policy, enabled: true, uploadEntitled: false },
            history: [{ backupId: "saved", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
          },
    ),
  );
  mount();
  await screen.findByText(copy.cloud_backup_promotion_title);
  expect(screen.getByRole("list", { name: copy.cloud_backup_history })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_unlock }));
  fireEvent.change(screen.getByLabelText(copy.cloud_backup_code), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: copy.cloud_backup_unlock }).at(-1)!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith({ action: "recover", code: "synthetic" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: copy.cloud_backup_enable })).not.toBeInTheDocument();
  expect(mocks.capture).not.toHaveBeenCalled();
});

it.each([false, true])(
  "shows the recovery deadline in backup settings and Connect (summary=%s)",
  async (summary) => {
    mocks.action.mockResolvedValue({
      ...status,
      hasKey: true,
      keyReady: true,
      policy: {
        ...status.policy,
        uploadEntitled: false,
        readGraceExpiresAt: "2026-12-31T12:00:00Z",
      },
      history: [{ backupId: "saved", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
    });
    mount(summary);
    const notice = await screen.findByText(/Download any copies you want to keep by/);
    expect(notice).toHaveTextContent("2026");
    expect(notice).not.toHaveTextContent("{{date}}");
    expect(notice).toHaveTextContent("Cloud copies will be deleted");
    expect(mocks.capture).not.toHaveBeenCalled();
  },
);

it("does not show a recovery deadline for renewed paid access", async () => {
  mocks.action.mockResolvedValue({
    ...status,
    hasKey: true,
    keyReady: true,
    policy: { ...status.policy, readGraceExpiresAt: "2026-12-31T12:00:00Z" },
    history: [{ backupId: "saved", publishedAt: "2026-10-01T00:00:00Z", sizeBytes: 123 }],
  });
  mount();
  await screen.findByRole("list", { name: copy.cloud_backup_history });
  expect(screen.queryByText(/Download any copies you want to keep by/)).not.toBeInTheDocument();
});

it("shows pending only during an explicit access attempt and gives missing-wrapper instructions", async () => {
  const locked = { ...status, hasKey: true };
  let finish: (value: string) => void = () => {};
  mocks.action.mockImplementation(async (op) =>
    op.action === "access"
      ? new Promise<string>((resolve) => {
          finish = resolve;
        })
      : locked,
  );
  mount();
  expect(
    await screen.findByRole("button", { name: copy.cloud_backup_access_check }),
  ).toBeInTheDocument();
  expect(screen.queryByText(copy.cloud_backup_access_running)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_access_check }));
  expect(await screen.findByText(copy.cloud_backup_access_running)).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  finish("unavailable");
  expect(await screen.findByText(copy.cloud_backup_access_missing)).toBeInTheDocument();
  expect(screen.queryByText(copy.cloud_backup_access_running)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: copy.cloud_backup_unlock })).toBeInTheDocument();
});
it("explains replacement before reissuing a code from the resume flow", async () => {
  mocks.action.mockResolvedValue({ ...status, hasKey: true, keyReady: true });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_resume }));
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_need_code }));
  expect(screen.getByRole("dialog")).toHaveTextContent(copy.cloud_backup_replace_description);
  expect(mocks.action.mock.calls.some(([op]) => op.action === "reissue")).toBe(false);
});

it("shows scheduled failures, retry time and a retry action in backup settings", async () => {
  const ready = {
    ...status,
    hasKey: true,
    keyReady: true,
    isSource: true,
    sourceConsented: true,
    policy: {
      ...status.policy,
      enabled: true,
      lastBackupAt: "2026-10-01T00:00:00Z",
      nextDueAt: "2026-10-02T00:00:00Z",
    },
  };
  mocks.action.mockImplementation((op) =>
    Promise.resolve(
      op.action === "runtimeStatus" ? { state: "failed", retryAt: "2026-10-06T10:30:00Z" } : ready,
    ),
  );
  mocks.capture.mockResolvedValue(null);
  mount();
  expect((await screen.findAllByText(copy.cloud_backup_state_failed)).length).toBeGreaterThan(0);
  expect(screen.getByText(copy.cloud_backup_hint_failed)).toBeInTheDocument();
  expect(screen.getByText(copy.cloud_backup_retry_label)).toBeInTheDocument();
  expect(screen.queryByText(copy.cloud_backup_state_due)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.cloud_backup_retry_now }));
  await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
});

it("updates runtime health without rereading cloud status, and isolates profile changes", async () => {
  let running = true;
  const ready = {
    ...status,
    hasKey: true,
    keyReady: true,
    isSource: true,
    sourceConsented: true,
    policy: {
      ...status.policy,
      enabled: true,
      lastBackupAt: "2026-10-01T00:00:00Z",
      nextDueAt: "2026-10-02T00:00:00Z",
    },
  };
  mocks.action.mockImplementation((op) =>
    Promise.resolve(
      op.action === "runtimeStatus"
        ? { state: running ? "running" : "failed", retryAt: null }
        : ready,
    ),
  );
  const view = mount(true);
  expect((await screen.findAllByText(copy.cloud_backup_state_running)).length).toBeGreaterThan(0);
  running = false;
  await view.client.invalidateQueries({ queryKey: ["cloud-backup-runtime", "profile-a:user-a"] });
  expect((await screen.findAllByText(copy.cloud_backup_state_failed)).length).toBeGreaterThan(0);
  expect(mocks.action.mock.calls.filter(([op]) => op.action === "status")).toHaveLength(1);
  mocks.profile = "profile-b";
  mocks.action.mockResolvedValue(status);
  view.rerender(view.element());
  await waitFor(() =>
    expect(screen.queryByText(copy.cloud_backup_state_failed)).not.toBeInTheDocument(),
  );
});

it("refreshes history after a capture that completes between progress reads", async () => {
  let completed = 0;
  const ready = {
    ...status,
    hasKey: true,
    keyReady: true,
    isSource: true,
    sourceConsented: true,
    policy: {
      ...status.policy,
      enabled: true,
      lastBackupAt: "2026-10-01T00:00:00Z",
      nextDueAt: "2026-10-02T00:00:00Z",
    },
  };
  const point = { backupId: "new-point", publishedAt: new Date().toISOString(), sizeBytes: 123 };
  mocks.action.mockImplementation((op) =>
    Promise.resolve(
      op.action === "runtimeStatus"
        ? { state: "idle", retryAt: null, completed }
        : { ...ready, history: completed ? [point] : [] },
    ),
  );
  const view = mount(true);
  await waitFor(() =>
    expect(view.client.getQueryData(["cloud-backup-runtime", "profile-a:user-a"])).toMatchObject({
      completed: 0,
    }),
  );
  completed = 1;
  await view.client.invalidateQueries({ queryKey: ["cloud-backup-runtime", "profile-a:user-a"] });
  await waitFor(() =>
    expect(view.client.getQueryData(["cloud-backups", "profile-a:user-a"])).toMatchObject({
      history: [point],
    }),
  );
  expect(mocks.action.mock.calls.filter(([op]) => op.action === "status")).toHaveLength(2);
});

it.each([
  { enabled: true, isSource: true, sourceConsented: true },
  { enabled: true, isSource: false, sourceConsented: false },
  { enabled: false, isSource: true, sourceConsented: false },
])("recovers access without asking to enable or move backups (%j)", async (source) => {
  let recovered = false;
  mocks.action.mockImplementation((op) => {
    if (op.action === "recover") {
      recovered = true;
      return Promise.resolve({});
    }
    return Promise.resolve({
      ...status,
      hasKey: true,
      keyReady: recovered,
      isSource: source.isSource,
      sourceConsented: source.sourceConsented,
      policy: { ...status.policy, enabled: source.enabled },
    });
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: copy.cloud_backup_unlock }));
  fireEvent.change(screen.getByLabelText(copy.cloud_backup_code), {
    target: { value: "synthetic" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: copy.cloud_backup_unlock }).at(-1)!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith({ action: "recover", code: "synthetic" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mocks.action.mock.calls.some(([op]) => op.action === "enable")).toBe(false);
  expect(mocks.capture).not.toHaveBeenCalled();
});
