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

  it("says a provider's data is shared with it", async () => {
    await openDataAccess(null);

    expect(screen.getByText("AI data sharing")).toBeInTheDocument();
    expect(screen.queryByText("Stays on this device")).not.toBeInTheDocument();
  });
});

const DEVICE_TOOLS = [
  "get_accounts",
  "get_holdings",
  "get_performance",
  "get_asset_allocation",
  "get_income",
  "get_cash_balances",
  "get_spending_insight",
  "record_activity",
];

function deviceProvider(deviceStatus: MergedProvider["deviceStatus"]): MergedProvider {
  return {
    ...provider(null),
    id: "apple-intelligence",
    name: "Apple Intelligence",
    type: "local",
    icon: "LogoApple",
    hasApiKey: false,
    supportedTools: DEVICE_TOOLS,
    deviceStatus,
  };
}

async function openDevice(deviceStatus: MergedProvider["deviceStatus"]) {
  const onToolsAllowlistChange = vi.fn();
  render(
    <ProviderSettingsCard
      provider={deviceProvider(deviceStatus)}
      onToggleEnabled={vi.fn()}
      onSetDefault={vi.fn()}
      onSaveApiKey={vi.fn()}
      onDeleteApiKey={vi.fn()}
      onRevealApiKey={vi.fn().mockResolvedValue(null)}
      onToolsAllowlistChange={onToolsAllowlistChange}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Apple Intelligence settings" }));
  return { onToolsAllowlistChange };
}

describe("ProviderSettingsCard for the device's own model", () => {
  it("shows only the data groups the model can use, kept on the device", async () => {
    await openDevice("available");

    expect(await screen.findByText("Stays on this device")).toBeInTheDocument();
    expect(screen.queryByText("AI data sharing")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^spending/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^holdings/i })).toBeInTheDocument();
    for (const hidden of [/^goals/i, /^history/i, /^classifications/i]) {
      expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Turned off")).not.toBeInTheDocument();
  });

  it("saves only the shown groups when one is turned off", async () => {
    const { onToolsAllowlistChange } = await openDevice("available");
    const spending = await screen.findByRole("button", { name: /^spending/i });

    await userEvent.click(spending);
    const allowlist = onToolsAllowlistChange.mock.calls[0]?.[0] as string[];
    expect(allowlist).toContain("get_holdings");
    for (const tool of SPENDING_TOOLS) expect(allowlist).not.toContain(tool);
    expect(allowlist).not.toContain("get_goals");
  });

  it("goes back to every tool once every shown group is on again", async () => {
    const onToolsAllowlistChange = vi.fn();
    const withoutSpending = DEVICE_TOOLS.filter((tool) => !SPENDING_TOOLS.includes(tool));
    render(
      <ProviderSettingsCard
        provider={{ ...deviceProvider("available"), toolsAllowlist: withoutSpending }}
        onToggleEnabled={vi.fn()}
        onSetDefault={vi.fn()}
        onSaveApiKey={vi.fn()}
        onDeleteApiKey={vi.fn()}
        onRevealApiKey={vi.fn().mockResolvedValue(null)}
        onToolsAllowlistChange={onToolsAllowlistChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Apple Intelligence settings" }));

    await userEvent.click(await screen.findByRole("button", { name: /^spending/i }));
    expect(onToolsAllowlistChange).toHaveBeenCalledWith(null);
  });

  it("says when the model is turned off on the device", async () => {
    await openDevice("notEnabled");

    expect(screen.getByText("Turned off")).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Apple Intelligence is turned off. Turn it on in System Settings to use this model.",
      ),
    ).toBeInTheDocument();
  });

  it("says when the model is not ready yet", async () => {
    await openDevice("modelNotReady");

    expect(screen.getByText("Not ready")).toBeInTheDocument();
  });
});
