import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormattingProvider } from "@wealthfolio/ui";
import { beforeEach, expect, it, vi } from "vitest";
import { useCheckForUpdates } from "@/hooks/use-updater";
import { UpdateDialog } from "./update-dialog";

vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "dialog-profile",
  usesLegacyPreferences: () => false,
}));
vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  isAutoUpdateCheckEnabled: vi.fn().mockResolvedValue(true),
  checkForUpdates: vi.fn().mockResolvedValue({ latestVersion: "4.0.0", screenshots: [] }),
  installUpdate: vi.fn(),
  getExternalUpdateSource: vi.fn().mockResolvedValue(null),
  openUrlInBrowser: vi.fn(),
}));

function ManualCheck() {
  const check = useCheckForUpdates();
  return <button onClick={() => check.mutate()}>Check now</button>;
}

beforeEach(() => localStorage.clear());

it("the actual update dialog reopens after snooze and a manual check", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <FormattingProvider locale="en-US">
        <ManualCheck />
        <UpdateDialog />
      </FormattingProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("New Update Available")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remind me later" }));
  await waitFor(() => expect(screen.queryByText("New Update Available")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Check now" }));
  expect(await screen.findByText("New Update Available")).toBeVisible();
  view.unmount();
  client.clear();
});
