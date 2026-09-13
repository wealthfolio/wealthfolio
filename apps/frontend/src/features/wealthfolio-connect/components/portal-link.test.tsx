import { ExternalLink } from "@/components/external-link";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PortalLink } from "./portal-link";

const openUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/adapters", () => ({ openUrlInBrowser: openUrl }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: () => "Opens in browser" }),
}));

it("names the destination and opens it through the platform adapter", () => {
  render(
    <PortalLink href="https://connect.wealthfolio.app/settings/devices" label="Manage devices" />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Manage devices — Opens in browser" }));
  expect(openUrl).toHaveBeenCalledWith("https://connect.wealthfolio.app/settings/devices");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("respects a caller that cancels external navigation", () => {
  render(
    <ExternalLink href="https://example.com" onClick={(event) => event.preventDefault()}>
      Cancel navigation
    </ExternalLink>,
  );
  fireEvent.click(screen.getByRole("link", { name: "Cancel navigation" }));
  expect(openUrl).not.toHaveBeenCalled();
});
