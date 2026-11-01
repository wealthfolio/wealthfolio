import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccessTokens } from "./use-access-tokens";
import { useAgentAudit } from "./use-agent-audit";
import { useMcpServer } from "./use-mcp-server";

const adapterMocks = vi.hoisted(() => ({
  isTauri: true,
  isWeb: true,
  getMcpStatus: vi.fn(),
  setMcpEnabled: vi.fn(),
  setMcpAutoStart: vi.fn(),
  startMcp: vi.fn(),
  stopMcp: vi.fn(),
  setMcpAuditEnabled: vi.fn(),
  listAgentAccessTokens: vi.fn(),
  createAgentAccessToken: vi.fn(),
  updateAgentAccessTokenScopes: vi.fn(),
  deleteAgentAccessToken: vi.fn(),
  listAgentAuditLog: vi.fn(),
  purgeAgentAuditLog: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

const status = {
  enabled: true,
  autoStart: false,
  auditEnabled: true,
  running: true,
  port: 9170,
  startedAt: "2026-06-09T00:00:00Z",
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMcpServer", () => {
  it("loads the status and forwards the enable toggle to the adapter", async () => {
    adapterMocks.getMcpStatus.mockResolvedValue(status);
    adapterMocks.setMcpEnabled.mockResolvedValue({ ...status, enabled: true });

    const { result } = renderHook(() => useMcpServer(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.status).toEqual(status));

    await act(async () => {
      await result.current.setEnabledMutation.mutateAsync(true);
    });

    expect(adapterMocks.setMcpEnabled).toHaveBeenCalledWith(true);
  });

  it("forwards the audit-logging toggle to the adapter", async () => {
    adapterMocks.getMcpStatus.mockResolvedValue(status);
    adapterMocks.setMcpAuditEnabled.mockResolvedValue({ ...status, auditEnabled: false });

    const { result } = renderHook(() => useMcpServer(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.status).toEqual(status));

    await act(async () => {
      await result.current.setAuditEnabledMutation.mutateAsync(false);
    });

    expect(adapterMocks.setMcpAuditEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(result.current.status?.auditEnabled).toBe(false));
  });
});

describe("useAccessTokens", () => {
  it("edits scopes and refreshes the token list without replacing the key", async () => {
    adapterMocks.listAgentAccessTokens.mockResolvedValue([{ id: "t1", scopes: ["accounts:read"] }]);
    adapterMocks.updateAgentAccessTokenScopes.mockResolvedValue({
      id: "t1",
      scopes: ["holdings:read"],
    });
    const { result } = renderHook(() => useAccessTokens(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    adapterMocks.listAgentAccessTokens.mockResolvedValue([{ id: "t1", scopes: ["holdings:read"] }]);
    await act(async () => {
      await result.current.updateMutation.mutateAsync({ id: "t1", scopes: ["holdings:read"] });
    });
    expect(adapterMocks.updateAgentAccessTokenScopes).toHaveBeenCalledWith("t1", {
      scopes: ["holdings:read"],
    });
    await waitFor(() => expect(result.current.tokens[0].scopes).toEqual(["holdings:read"]));
    expect(adapterMocks.createAgentAccessToken).not.toHaveBeenCalled();
  });

  it("updates cached permissions immediately and waits for a delayed refetch before closing", async () => {
    const initial = [{ id: "t1", scopes: ["accounts:read", "holdings:read"] }];
    const updated = { id: "t1", scopes: ["accounts:read"] };
    let finishRefetch: (tokens: typeof initial) => void = () => undefined;
    const delayedRefetch = new Promise<typeof initial>((resolve) => {
      finishRefetch = resolve;
    });
    adapterMocks.listAgentAccessTokens
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(delayedRefetch);
    adapterMocks.updateAgentAccessTokenScopes.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => useAccessTokens(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    const closed = vi.fn();
    let saved: Promise<unknown> = Promise.resolve();
    act(() => {
      saved = result.current.updateMutation
        .mutateAsync({ id: "t1", scopes: ["accounts:read"] })
        .then(closed);
    });
    await waitFor(() => expect(adapterMocks.listAgentAccessTokens).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.tokens[0].scopes).toEqual(["accounts:read"]));
    expect(result.current.updateMutation.isPending).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    await act(async () => {
      finishRefetch([updated]);
      await saved;
    });
    expect(closed).toHaveBeenCalledOnce();
    expect(result.current.tokens[0].scopes).toEqual(["accounts:read"]);
  });

  it("keeps the current permissions when the update fails", async () => {
    adapterMocks.listAgentAccessTokens.mockResolvedValue([{ id: "t1", scopes: ["accounts:read"] }]);
    adapterMocks.updateAgentAccessTokenScopes.mockRejectedValueOnce(new Error("Save failed"));
    const { result } = renderHook(() => useAccessTokens(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    await act(async () => {
      await expect(
        result.current.updateMutation.mutateAsync({ id: "t1", scopes: ["holdings:read"] }),
      ).rejects.toThrow("Save failed");
    });
    expect(result.current.tokens[0].scopes).toEqual(["accounts:read"]);
    expect(adapterMocks.listAgentAccessTokens).toHaveBeenCalledOnce();
    expect(adapterMocks.createAgentAccessToken).not.toHaveBeenCalled();
  });

  it("creates and removes tokens through the adapter", async () => {
    adapterMocks.listAgentAccessTokens.mockResolvedValue([]);
    adapterMocks.createAgentAccessToken.mockResolvedValue({ token: "wfp_secret", id: "t1" });
    adapterMocks.deleteAgentAccessToken.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAccessTokens(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.createMutation.mutateAsync({
        name: "Claude",
        expiresAt: "2026-09-09T00:00:00.000Z",
        scopes: ["accounts:read"],
      });
      await result.current.deleteMutation.mutateAsync("t1");
    });

    expect(adapterMocks.createAgentAccessToken).toHaveBeenCalledWith({
      name: "Claude",
      expiresAt: "2026-09-09T00:00:00.000Z",
      scopes: ["accounts:read"],
    });
    expect(adapterMocks.deleteAgentAccessToken).toHaveBeenCalledWith("t1");
  });
});

describe("useAgentAudit", () => {
  it("queries the requested page and purges through the adapter", async () => {
    adapterMocks.listAgentAuditLog.mockResolvedValue({
      items: [],
      totalCount: 0,
      availableTools: [],
    });
    adapterMocks.purgeAgentAuditLog.mockResolvedValue(3);

    const query = {
      page: 2,
      pageSize: 25,
      q: "holdings",
      tools: ["get_holdings"],
      outcomes: ["success"],
      actorKinds: ["pat"],
    };
    const { result } = renderHook(() => useAgentAudit(query), { wrapper: createWrapper() });

    await waitFor(() => expect(adapterMocks.listAgentAuditLog).toHaveBeenCalledWith(query));

    await act(async () => {
      await result.current.purgeMutation.mutateAsync();
    });

    expect(adapterMocks.purgeAgentAuditLog).toHaveBeenCalled();
  });
});
