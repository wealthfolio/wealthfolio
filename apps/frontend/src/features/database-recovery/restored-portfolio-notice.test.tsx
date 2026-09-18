import { render } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/settings.json";
import { RestoredPortfolioNotice } from "./restored-portfolio-notice";

const mocks = vi.hoisted(() => ({
  settings: null as { restoreReconnectRequired: boolean } | null,
  info: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: mocks.settings }),
}));
vi.mock("sonner", () => ({ toast: { info: mocks.info, dismiss: mocks.dismiss } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = null;
});

it("waits for restored database settings rather than announcing during loading", () => {
  const view = render(<RestoredPortfolioNotice />);
  expect(mocks.info).not.toHaveBeenCalled();
  mocks.settings = { restoreReconnectRequired: false };
  view.rerender(<RestoredPortfolioNotice />);
  expect(mocks.info).not.toHaveBeenCalled();
  mocks.settings = { restoreReconnectRequired: true };
  view.rerender(<RestoredPortfolioNotice />);
  expect(mocks.info).toHaveBeenCalledWith(copy.backup_restored_title, {
    id: "restored-portfolio",
    description: copy.backup_import_reconnect,
    duration: Infinity,
  });
  view.rerender(<RestoredPortfolioNotice />);
  expect(mocks.info).toHaveBeenCalledTimes(1);
});

it("removes stale feedback on reconnect or unmount without changing backend state", () => {
  mocks.settings = { restoreReconnectRequired: true };
  const view = render(<RestoredPortfolioNotice />);
  mocks.settings = { restoreReconnectRequired: false };
  view.rerender(<RestoredPortfolioNotice />);
  expect(mocks.dismiss).toHaveBeenCalledWith("restored-portfolio");
  mocks.settings = { restoreReconnectRequired: true };
  view.rerender(<RestoredPortfolioNotice />);
  view.unmount();
  expect(mocks.settings.restoreReconnectRequired).toBe(true);
  expect(mocks.dismiss).toHaveBeenCalledTimes(2);
});
