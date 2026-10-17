import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import settings from "@/i18n/locales/en/settings.json";
import AboutSettingsPage from "./about-page";

const { checkForUpdates, getExternalUpdateSource, toast } = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  getExternalUpdateSource: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "about-profile",
  usesLegacyPreferences: () => false,
}));
vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  getAppInfo: vi.fn().mockResolvedValue({ version: "3.9.1", dbPath: "", logsDir: "" }),
  isAutoUpdateCheckEnabled: vi.fn(),
  checkForUpdates,
  getExternalUpdateSource,
  installUpdate: vi.fn(),
}));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: false }) }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast }));

beforeEach(() => {
  checkForUpdates.mockReset().mockResolvedValue(null);
  getExternalUpdateSource.mockReset();
  toast.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AboutSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByRole("button", { name: settings.about_check_update_button });
}

it.each([
  [
    { kind: "packager", explanation: "Update Wealthfolio with pacman." },
    "Update Wealthfolio with pacman.",
  ],
  [{ kind: "flatpak" }, settings.about_updates_external_flatpak],
  [{ kind: "packageManager" }, settings.about_updates_external_package_manager],
] as const)("explains where updates come from for %o", async (source, description) => {
  getExternalUpdateSource.mockResolvedValue(source);
  const button = await renderPage();
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(toast).toHaveBeenCalledWith({
    title: settings.about_updates_external_title,
    description,
  });
  expect(checkForUpdates).not.toHaveBeenCalled();
});

it("checks the update feed when the app updates itself", async () => {
  getExternalUpdateSource.mockResolvedValue(null);
  const button = await renderPage();
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(checkForUpdates).toHaveBeenCalledWith({ force: true }));
});

it("waits for the update source before allowing a check", async () => {
  getExternalUpdateSource.mockReturnValue(new Promise(() => undefined));
  const button = await renderPage();
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(checkForUpdates).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});
