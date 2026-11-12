import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MergedProvider } from "../types";
import { ProviderSettingsCard } from "./provider-settings-card";

const SPENDING_TOOLS = [
  "get_spending_context",
  "search_spending_transactions",
  "get_budget",
  "list_spending_events",
  "get_spending_report",
  "get_spending_insight",
  "get_event_spending_summaries",
];

function provider(toolsAllowlist: string[] | null): MergedProvider {
  return {
    id: "google",
    name: "Google AI",
    type: "api",
    icon: "google",
    description: "",
    envKey: "",
    connectionFields: [],
    models: [],
    defaultModel: "",
    documentationUrl: "",
    enabled: true,
    favorite: false,
    priority: 0,
    favoriteModels: [],
    modelCapabilityOverrides: {},
    toolsAllowlist,
    hasApiKey: true,
    isDefault: true,
    supportsModelListing: false,
  };
}

async function openDataAccess(toolsAllowlist: string[] | null) {
  const onToolsAllowlistChange = vi.fn();
  render(
    <ProviderSettingsCard
      provider={provider(toolsAllowlist)}
      onToggleEnabled={vi.fn()}
      onSetDefault={vi.fn()}
      onSaveApiKey={vi.fn()}
      onDeleteApiKey={vi.fn()}
      onRevealApiKey={vi.fn().mockResolvedValue(null)}
      onToolsAllowlistChange={onToolsAllowlistChange}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Google AI settings" }));
  const spending = await screen.findByRole("button", { name: /^spending/i });
  return { onToolsAllowlistChange, spending };
}

describe("ProviderSettingsCard data access", () => {
  it("turns off every Spending tool together", async () => {
    const { onToolsAllowlistChange, spending } = await openDataAccess(null);

    await userEvent.click(spending);

    const allowlist = onToolsAllowlistChange.mock.calls[0]?.[0] as string[];
    expect(allowlist).toContain("get_holdings");
    for (const tool of SPENDING_TOOLS) expect(allowlist).not.toContain(tool);
  });

  it("leaves Spending off for a saved list and turns it on as one group", async () => {
    const { onToolsAllowlistChange, spending } = await openDataAccess(["get_holdings"]);

    await userEvent.click(spending);

    const allowlist = onToolsAllowlistChange.mock.calls[0]?.[0] as string[];
    expect(allowlist).toEqual(expect.arrayContaining(["get_holdings", ...SPENDING_TOOLS]));
  });
});
