import {
  getMcpStatus,
  isDesktop,
  logger,
  setMcpAuditEnabled,
  setMcpAutoStart,
  setMcpEnabled,
  startMcp,
  stopMcp,
  type McpServerStatus,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useMcpServer() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: [QueryKeys.AGENT_MCP_STATUS],
    queryFn: getMcpStatus,
    enabled: isDesktop,
  });

  const applyStatus = (status: McpServerStatus) => {
    queryClient.setQueryData([QueryKeys.AGENT_MCP_STATUS], status);
  };

  const setEnabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setMcpEnabled(enabled),
    onSuccess: applyStatus,
    onError: (error) => {
      logger.error(`Error updating Agent Access: ${String(error)}`);
      toast({
        title: "Failed to update Agent Access",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const setAutoStartMutation = useMutation({
    mutationFn: (autoStart: boolean) => setMcpAutoStart(autoStart),
    onSuccess: applyStatus,
    onError: (error) => {
      logger.error(`Error updating MCP auto-start: ${String(error)}`);
      toast({
        title: "Failed to update auto-start",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const startMutation = useMutation({
    mutationFn: () => startMcp(),
    onSuccess: applyStatus,
    onError: (error) => {
      logger.error(`Error starting MCP server: ${String(error)}`);
      toast({
        title: "Failed to start server",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopMcp(),
    onSuccess: applyStatus,
    onError: (error) => {
      logger.error(`Error stopping MCP server: ${String(error)}`);
      toast({
        title: "Failed to stop server",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const setAuditEnabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setMcpAuditEnabled(enabled),
    onSuccess: applyStatus,
    onError: (error) => {
      logger.error(`Error updating MCP audit logging: ${String(error)}`);
      toast({
        title: "Failed to update audit logging",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  return {
    status: statusQuery.data,
    isLoading: statusQuery.isLoading,
    isError: statusQuery.isError,
    refetchStatus: statusQuery.refetch,
    setEnabledMutation,
    setAutoStartMutation,
    startMutation,
    stopMutation,
    setAuditEnabledMutation,
  };
}
