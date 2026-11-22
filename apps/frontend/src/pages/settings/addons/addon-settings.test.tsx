import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import AddonSettingsPage from "./addon-settings";

vi.mock("@/addons/addons-runtime-context", () => ({
  getDynamicNavItems: () => [],
  subscribeToNavigationUpdates: () => () => {},
}));
vi.mock("@/pages/layouts/navigation/addon-navigation-pins", () => ({
  useAddonNavigationPins: () => ({ isAddonPinned: () => false, setAddonPinned: vi.fn() }),
}));
vi.mock("@/pages/layouts/mobile-stack/use-mobile-stack", () => ({
  useBackNavigation: () => vi.fn(),
}));
vi.mock("./components/addon-permission-dialog", () => ({ PermissionDialog: () => null }));
vi.mock("./components/addon-store-browser", () => ({ AddonStoreBrowser: () => null }));
vi.mock("./components/rating-dialog", () => ({ RatingDialog: () => null }));
vi.mock("./hooks/use-addon-updates", () => ({
  useAddonUpdates: () => ({
    hasUpdates: () => false,
    getUpdateResult: () => ({
      updateInfo: {
        updateAvailable: true,
        currentVersion: "1",
        latestVersion: "2",
        releaseNotes: "Fixes",
      },
    }),
  }),
}));

const mocks = vi.hoisted(() => ({
  getInstalledAddons: vi.fn(),
  uninstallAddon: vi.fn(),
  reloadAllAddons: vi.fn(),
  toast: vi.fn(),
  openUrlInBrowser: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  installAddon: vi.fn(),
  getInstalledAddons: mocks.getInstalledAddons,
  toggleAddon: vi.fn(),
  uninstallAddon: mocks.uninstallAddon,
  extractAddon: vi.fn(),
  clearAddonStaging: vi.fn(),
  updateAddonNetworkApprovals: vi.fn(),
  openUrlInBrowser: mocks.openUrlInBrowser,
}));

vi.mock("@/addons/addons-core", () => ({
  reloadAllAddons: mocks.reloadAllAddons,
}));

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

// The add-on card: the confirmation renders outside it, in a portal.
function tileOf(name: string) {
  return screen.getByText(name).closest<HTMLElement>('[class*="sm:p-6"]')!;
}

it("shows a removal in progress on the card and in the confirmation, until it ends", async () => {
  let finishFirst!: () => void;
  const other = {
    metadata: { id: "other-addon", name: "Other Add-on", enabled: true, permissions: [] },
  };
  mocks.getInstalledAddons.mockResolvedValue([
    { metadata: { id: "slow-addon", name: "Slow Add-on", enabled: true, permissions: [] } },
    other,
  ]);
  mocks.uninstallAddon
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          finishFirst = () => reject(new Error("busy"));
        }),
    )
    .mockResolvedValueOnce(undefined);

  render(<AddonSettingsPage />, { wrapper: createWrapper() });
  await screen.findByText("Slow Add-on");
  const tile = within(tileOf("Slow Add-on"));
  const otherTile = within(tileOf("Other Add-on"));
  const openConfirm = tile.getByRole("button", { name: "Remove add-on" });
  fireEvent.click(openConfirm);
  const deleteButton = await screen.findByRole("button", { name: "Delete" });
  expect(deleteButton).toBeEnabled();
  fireEvent.click(deleteButton);

  const busy = await screen.findByRole("button", { name: "Deleting..." });
  expect(busy).toBeDisabled();
  expect(tile.getByRole("switch")).toHaveAttribute("data-disabled");
  expect(tile.getByRole("button", { name: "Update" })).toBeDisabled();
  fireEvent.click(busy);
  expect(mocks.uninstallAddon).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Deleting..." })).toBeNull());
  // Focus returns to the trash button, which stays focusable while disabled.
  await waitFor(() => expect(openConfirm).toHaveFocus());

  // With the confirmation closed, the card itself shows the removal.
  expect(tileOf("Slow Add-on")).toHaveAttribute("aria-busy", "true");
  expect(tileOf("Slow Add-on")).toHaveClass("bg-muted");
  expect(tileOf("Slow Add-on")).not.toHaveClass("opacity-50");
  expect(openConfirm).toHaveAttribute("aria-disabled", "true");
  expect(openConfirm.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(tile.getByRole("button", { name: "View permissions" })).toBeDisabled();
  expect(tile.getByRole("button", { name: "Rate add-on" })).toBeDisabled();
  const releaseNotes = tile.getByRole("link", { name: "Release notes" });
  expect(releaseNotes).toHaveAttribute("aria-disabled", "true");
  expect(releaseNotes).toHaveAttribute("tabindex", "-1");
  fireEvent.click(releaseNotes);
  expect(mocks.openUrlInBrowser).not.toHaveBeenCalled();
  fireEvent.click(openConfirm);
  expect(screen.queryByRole("button", { name: "Deleting..." })).toBeNull();

  // The other add-on's card is unaffected.
  expect(tileOf("Other Add-on")).not.toHaveAttribute("aria-busy");
  expect(tileOf("Other Add-on")).not.toHaveClass("bg-muted");
  expect(otherTile.getByRole("button", { name: "Remove add-on" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect(otherTile.getByRole("switch")).not.toHaveAttribute("data-disabled");
  expect(otherTile.getByRole("button", { name: "Update" })).toBeEnabled();
  expect(otherTile.getByRole("link", { name: "Release notes" })).not.toHaveAttribute(
    "aria-disabled",
  );

  await act(async () => finishFirst());
  await waitFor(() => expect(openConfirm).toHaveAttribute("aria-disabled", "false"));
  expect(tileOf("Slow Add-on")).not.toHaveAttribute("aria-busy");
  expect(tileOf("Slow Add-on")).not.toHaveClass("bg-muted");
  expect(openConfirm.querySelector('[data-slot="spinner"]')).toBeNull();
  expect(tile.getByRole("button", { name: "View permissions" })).toBeEnabled();
  expect(tile.getByRole("button", { name: "Rate add-on" })).toBeEnabled();
  expect(tile.getByRole("switch")).not.toHaveAttribute("data-disabled");
  expect(tile.getByRole("button", { name: "Update" })).toBeEnabled();
  expect(releaseNotes).not.toHaveAttribute("aria-disabled");
  expect(releaseNotes).not.toHaveAttribute("tabindex");
  fireEvent.click(releaseNotes);
  expect(mocks.openUrlInBrowser).toHaveBeenCalledTimes(1);
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));

  fireEvent.click(openConfirm);
  expect(await screen.findByRole("button", { name: "Delete" })).toBeEnabled();
  mocks.getInstalledAddons.mockResolvedValue([other]);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByText("Slow Add-on")).toBeNull());
  expect(screen.getByText("Other Add-on")).toBeInTheDocument();
  expect(mocks.uninstallAddon).toHaveBeenCalledTimes(2);
});
