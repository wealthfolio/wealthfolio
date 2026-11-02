import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateAgentAccessTokenScopes as updateTauri } from "./tauri/agent-access";
import { updateAgentAccessTokenScopes as updateWeb } from "./web/agent-access";

const mocks = vi.hoisted(() => ({ tauri: vi.fn(), web: vi.fn() }));
vi.mock("./tauri/core", () => ({ invoke: mocks.tauri, logger: { error: vi.fn() } }));
vi.mock("./web/core", () => ({ invoke: mocks.web, logger: { error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe("agent token permission adapters", () => {
  it.each([
    ["Tauri", updateTauri, mocks.tauri, "mcp_update_token_scopes"],
    ["web", updateWeb, mocks.web, "update_agent_access_token_scopes"],
  ] as const)(
    "%s forwards only the token ID and scopes",
    async (_host, update, invoke, command) => {
      const metadata = { id: "key-1", scopes: ["holdings:read"] };
      invoke.mockResolvedValueOnce(metadata);
      await expect(update("key-1", { scopes: ["holdings:read"] })).resolves.toEqual(metadata);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(command, {
        id: "key-1",
        scopes: ["holdings:read"],
      });
    },
  );
});
