// Agent Access Commands (embedded MCP server)
import type {
  AgentAccessStatus,
  AgentAccessToken,
  AgentAuditEntry,
  AgentAuditPage,
  AgentAuditQuery,
  CreateAgentAccessTokenInput,
  CreatedAgentAccessToken,
  McpServerStatus,
} from "../types";

import { invoke, logger } from "./core";

/** Raw audit row as serialized by the Tauri backend (snake_case, scopes as JSON). */
interface McpAuditLogRow {
  id: string;
  session_id: string;
  actor_kind: string;
  actor_fingerprint: string;
  tool: string;
  scopes_json: string;
  args_summary: string | null;
  outcome: string;
  error_message: string | null;
  created_at: string;
}

const toAuditEntry = (row: McpAuditLogRow): AgentAuditEntry => {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes_json);
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((scope): scope is string => typeof scope === "string");
    }
  } catch (_error) {
    // Malformed scopes JSON — show the entry without scopes.
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    actorKind: row.actor_kind,
    actorFingerprint: row.actor_fingerprint,
    tool: row.tool,
    scopes,
    argsSummary: row.args_summary,
    outcome: row.outcome,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
};

export const getMcpStatus = async (): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_get_status");
  } catch (error) {
    logger.error("Error fetching MCP server status.");
    throw error;
  }
};

export const setMcpEnabled = async (enabled: boolean): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_set_enabled", { enabled });
  } catch (error) {
    logger.error("Error updating Agent Access feature setting.");
    throw error;
  }
};

export const setMcpAutoStart = async (autoStart: boolean): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_set_auto_start", { autoStart });
  } catch (error) {
    logger.error("Error updating MCP auto-start setting.");
    throw error;
  }
};

export const startMcp = async (): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_start");
  } catch (error) {
    logger.error("Error starting MCP server.");
    throw error;
  }
};

export const stopMcp = async (): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_stop");
  } catch (error) {
    logger.error("Error stopping MCP server.");
    throw error;
  }
};

export const setMcpAuditEnabled = async (enabled: boolean): Promise<McpServerStatus> => {
  try {
    return await invoke<McpServerStatus>("mcp_set_audit_enabled", { enabled });
  } catch (error) {
    logger.error("Error updating MCP audit logging setting.");
    throw error;
  }
};

export const listAgentAuditLog = async (query: AgentAuditQuery): Promise<AgentAuditPage> => {
  try {
    const result = await invoke<{
      items: McpAuditLogRow[];
      totalCount: number;
      availableTools: string[];
    }>("mcp_list_audit_log", {
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      tools: query.tools,
      outcomes: query.outcomes,
      actorKinds: query.actorKinds,
    });
    return {
      items: result.items.map(toAuditEntry),
      totalCount: result.totalCount,
      availableTools: result.availableTools,
    };
  } catch (error) {
    logger.error("Error listing agent audit log.");
    throw error;
  }
};

export const purgeAgentAuditLog = async (): Promise<number> => {
  try {
    return await invoke<number>("mcp_purge_audit_log");
  } catch (error) {
    logger.error("Error purging agent audit log.");
    throw error;
  }
};

// The web-server status concept doesn't apply to the embedded desktop server.
export const getAgentAccessStatus = (): Promise<AgentAccessStatus> =>
  Promise.reject(new Error("Agent access status is reported via the MCP server status on desktop"));

// Personal access tokens mirror the web token endpoints, backed by the embedded
// MCP server's token store.

export const listAgentAccessTokens = async (): Promise<AgentAccessToken[]> => {
  try {
    return await invoke<AgentAccessToken[]>("mcp_list_tokens");
  } catch (error) {
    logger.error("Error listing personal access tokens.");
    throw error;
  }
};

export const createAgentAccessToken = async (
  input: CreateAgentAccessTokenInput,
): Promise<CreatedAgentAccessToken> => {
  try {
    return await invoke<CreatedAgentAccessToken>("mcp_create_token", {
      name: input.name,
      expiresAt: input.expiresAt,
      scopes: input.scopes,
    });
  } catch (error) {
    logger.error("Error creating personal access token.");
    throw error;
  }
};

export const deleteAgentAccessToken = async (id: string): Promise<void> => {
  try {
    await invoke<void>("mcp_delete_token", { id });
  } catch (error) {
    logger.error("Error removing personal access token.");
    throw error;
  }
};
