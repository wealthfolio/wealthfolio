import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { ProfileShell } from "@/features/profiles/profile-shell";
import { NativeDatabaseGate } from "@/features/database-recovery/native-database-gate";
import { SettingsProvider } from "@/lib/settings-provider";
import { WealthfolioConnectProvider } from "@/features/wealthfolio-connect/providers/wealthfolio-connect-provider";
import type { Settings } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  database: vi.fn(),
  settings: vi.fn(),
  language: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));
vi.mock("@/features/profiles/api", () => ({
  profileCommand: (command: string) =>
    command === "get_profile_state" ? mocks.profile() : Promise.resolve(0),
  profileChangesChannel: new EventTarget(),
}));
vi.mock("@/features/profiles/session", () => ({
  installProfileSession: () => true,
  profileScope: () => "test-scope",
  revokeProfileSession: vi.fn(),
}));
vi.mock("@/features/profiles/auth-bridge", () => ({ isNativeAuthPending: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/adapters", () => ({
  isWeb: false,
  isDesktop: false,
  getSettings: () => mocks.settings(),
  logger: { error: vi.fn() },
}));
vi.mock("../adapters/tauri/settings", () => ({
  getDatabaseStartupStatus: () => mocks.database(),
  discardDatabaseBackupImport: vi.fn(),
}));
vi.mock("../adapters/tauri/files", () => ({ openDatabaseFileDialog: vi.fn() }));
vi.mock("@/context/auth-context", () => ({
  useAuth: () => ({ isAuthenticated: true, statusLoading: false }),
}));
vi.mock("@/hooks/use-settings-mutation", () => ({
  useSettingsMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/connect-config", () => ({ CONNECT_ENABLED: false }));
vi.mock("@/i18n/i18n", () => ({
  LANGUAGE_STORAGE_KEY: "test-language",
  default: {
    language: "en",
    isInitialized: true,
    changeLanguage: () => mocks.language(),
    dir: () => "ltr",
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const settings = {
  theme: "dark",
  font: "font-serif",
  language: "fr",
  formattingRegion: "system",
  timezone: "UTC",
  onboardingCompleted: true,
} as Settings;
function Portfolio() {
  useEffect(() => {
    mocks.mounted();
    return mocks.unmounted;
  }, []);
  return <p>Destination portfolio</p>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <ProfileShell>
        <NativeDatabaseGate>
          <SettingsProvider>
            <WealthfolioConnectProvider>
              <Portfolio />
            </WealthfolioConnectProvider>
          </SettingsProvider>
        </NativeDatabaseGate>
      </ProfileShell>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.profile.mockResolvedValue({
    profiles: [{ id: "a", name: "Personal", avatarId: "clay-pebble-animated", lockEnabled: false }],
    session: { profileId: "a", scopeId: "scope" },
    starting: false,
  });
  mocks.database.mockResolvedValue({
    ready: true,
    generation: "1",
    maintenance: false,
    error: null,
  });
  mocks.settings.mockResolvedValue(settings);
  mocks.language.mockResolvedValue(undefined);
});
it("keeps one opening surface through delayed profile, database, settings, and language readiness", async () => {
  const profile = deferred<unknown>();
  const database = deferred<unknown>();
  const fetched = deferred<Settings>();
  const language = deferred<void>();
  const readyProfile = {
    profiles: [{ id: "a", name: "Personal", avatarId: "clay-pebble-animated", lockEnabled: false }],
    session: { profileId: "a", scopeId: "scope" },
    starting: false,
  };
  mocks.profile.mockReturnValue(profile.promise);
  mocks.database.mockReturnValue(database.promise);
  mocks.settings.mockReturnValue(fetched.promise);
  mocks.language.mockReturnValue(language.promise);
  mount();
  expect(screen.queryByText("Who's using Wealthfolio?")).not.toBeInTheDocument();
  expect(mocks.database).not.toHaveBeenCalled();
  await act(async () => profile.resolve(readyProfile));
  await waitFor(() => expect(mocks.database).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("Opening Personal");
  expect(mocks.settings).not.toHaveBeenCalled();
  await act(async () =>
    database.resolve({ ready: true, generation: "1", maintenance: false, error: null }),
  );
  await waitFor(() => expect(mocks.settings).toHaveBeenCalled());
  expect(screen.getByRole("status")).toHaveTextContent("Opening Personal");
  await act(async () => fetched.resolve(settings));
  await waitFor(() => expect(mocks.language).toHaveBeenCalled());
  expect(screen.queryByText("Destination portfolio")).not.toBeInTheDocument();
  await act(async () => language.resolve());
  expect(await screen.findByText("Destination portfolio")).toBeInTheDocument();
  expect(document.documentElement).toHaveClass("dark");
  expect(document.body).toHaveClass("font-serif");
  expect(mocks.mounted).toHaveBeenCalledOnce();
});
it("keeps mounted routes during settings refreshes", async () => {
  const { client } = mount();
  await screen.findByText("Destination portfolio");
  mocks.settings.mockResolvedValue({ ...settings, theme: "light" });
  await act(async () => {
    await client.invalidateQueries();
  });
  await waitFor(() => expect(document.documentElement).toHaveClass("light"));
  expect(mocks.mounted).toHaveBeenCalledOnce();
  expect(mocks.unmounted).not.toHaveBeenCalled();
});
it("offers recovery before mounting the portfolio when settings fail", async () => {
  mocks.settings.mockRejectedValue(new Error("Settings unavailable"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings unavailable");
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Switch profile" })).toBeInTheDocument();
  expect(mocks.mounted).not.toHaveBeenCalled();
});
