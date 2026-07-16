// Ready-to-paste MCP client configuration snippets. Shared by the connect-client
// card (token placeholder) and the token-created dialog (real token), so both
// render identical configs for each known agent.

/** Placeholder used when no real token is available (the connect card). */
export const TOKEN_PLACEHOLDER = "YOUR_TOKEN";

/**
 * The config shape most MCP clients share (Claude Desktop, Claude Code,
 * Cursor, Windsurf, Cline). Used as the single "Copy config" default; the
 * help popover documents the few clients that differ (VS Code, Jan).
 */
export const STANDARD_PRESET_ID = "claude-desktop";

export interface ClientPreset {
  id: string;
  label: string;
  /** Where the user pastes this config (file path or UI location). */
  location?: string;
  build: (url: string, token: string) => unknown;
}

/** Shape shared by Claude Desktop, Claude Code, Cursor, Windsurf, Cline, … */
const mcpServers = (url: string, token: string) => ({
  mcpServers: {
    wealthfolio: {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
});

export const CLIENT_PRESETS: ClientPreset[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    location: "claude_desktop_config.json (Settings → Developer → Edit Config)",
    build: mcpServers,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    location: ".mcp.json in your project root",
    build: mcpServers,
  },
  {
    id: "cursor",
    label: "Cursor",
    location: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    build: mcpServers,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    location: "~/.codeium/windsurf/mcp_config.json",
    build: mcpServers,
  },
  {
    id: "cline",
    label: "Cline",
    location: "Cline → MCP Servers → Configure (cline_mcp_settings.json)",
    build: mcpServers,
  },
  {
    id: "vscode",
    label: "VS Code",
    location: ".vscode/mcp.json",
    build: (url, token) => ({
      servers: {
        wealthfolio: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
  },
  {
    id: "jan",
    label: "Jan",
    location: "Settings → MCP Servers → Add",
    build: (url, token) => ({
      Wealthfolio: {
        active: true,
        args: [],
        command: "",
        env: {},
        headers: { Authorization: `Bearer ${token}` },
        type: "http",
        url,
      },
    }),
  },
  {
    id: "generic",
    label: "Generic HTTP",
    location: "Any client that speaks Streamable HTTP",
    build: (url, token) => ({
      url,
      headers: { Authorization: `Bearer ${token}` },
    }),
  },
];

/**
 * Serialized config JSON for a preset. When `token` is omitted, a
 * `YOUR_TOKEN` placeholder is used so the snippet stays valid JSON the user
 * fills in after creating a token. Returns "" when the URL is missing.
 */
export function buildClientConfig(presetId: string, url: string, token?: string): string {
  const preset = CLIENT_PRESETS.find((entry) => entry.id === presetId) ?? CLIENT_PRESETS[0];
  if (!url) return "";
  return JSON.stringify(preset.build(url, token || TOKEN_PLACEHOLDER), null, 2);
}
