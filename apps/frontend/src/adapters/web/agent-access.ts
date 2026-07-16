// Web adapter - Agent Access Commands (PATs + audit log via REST)
import type {
  AgentAccessStatus,
  AgentAccessToken,
  AgentAuditPage,
  AgentAuditQuery,
  CreateAgentAccessTokenInput,
  CreatedAgentAccessToken,
  McpServerStatus,
} from "../types";

import { invoke, logger } from "./core";

export const getAgentAccessStatus = async (): Promise<AgentAccessStatus> => {
  try {
    return await invoke<AgentAccessStatus>("get_agent_access_status");
  } catch (error) {
    logger.error("Error fetching agent access status.");
    throw error;
  }
};

export const listAgentAccessTokens = async (): Promise<AgentAccessToken[]> => {
  try {
    return await invoke<AgentAccessToken[]>("list_agent_access_tokens");
  } catch (error) {
    logger.error("Error listing personal access tokens.");
    throw error;
  }
};

export const createAgentAccessToken = async (
  input: CreateAgentAccessTokenInput,
): Promise<CreatedAgentAccessToken> => {
  try {
    return await invoke<CreatedAgentAccessToken>("create_agent_access_token", {
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
    await invoke<void>("delete_agent_access_token", { id });
  } catch (error) {
    logger.error("Error removing personal access token.");
    throw error;
  }
};

export const listAgentAuditLog = async (query: AgentAuditQuery): Promise<AgentAuditPage> => {
  try {
    return await invoke<AgentAuditPage>("list_agent_audit_log", {
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      tools: query.tools,
      outcomes: query.outcomes,
      actorKinds: query.actorKinds,
    });
  } catch (error) {
    logger.error("Error listing agent audit log.");
    throw error;
  }
};

export const purgeAgentAuditLog = async (): Promise<number> => {
  try {
    const result = await invoke<{ purged: number }>("purge_agent_audit_log");
    return result.purged;
  } catch (error) {
    logger.error("Error purging agent audit log.");
    throw error;
  }
};

// Embedded MCP server controls are desktop-only.

export const getMcpStatus = (): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));

export const setMcpEnabled = (_enabled: boolean): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));

export const setMcpAutoStart = (_autoStart: boolean): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));

export const startMcp = (): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));

export const stopMcp = (): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));

export const setMcpAuditEnabled = (_enabled: boolean): Promise<McpServerStatus> =>
  Promise.reject(new Error("The MCP server runs inside the desktop app"));
