import { type AgentAuditQuery, listAgentAuditLog, logger, purgeAgentAuditLog } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useAgentAudit(query: AgentAuditQuery) {
  const queryClient = useQueryClient();

  const auditQuery = useQuery({
    queryKey: [QueryKeys.AGENT_AUDIT_LOG, query],
    queryFn: () => listAgentAuditLog(query),
    placeholderData: keepPreviousData,
  });

  const purgeMutation = useMutation({
    mutationFn: purgeAgentAuditLog,
    onSuccess: (purged) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.AGENT_AUDIT_LOG] });
      toast({
        title: "Audit log cleared",
        description: `${purged} ${purged === 1 ? "entry" : "entries"} removed.`,
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error purging agent audit log: ${String(error)}`);
      toast({
        title: "Failed to clear audit log",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  return {
    items: auditQuery.data?.items ?? [],
    totalCount: auditQuery.data?.totalCount ?? 0,
    availableTools: auditQuery.data?.availableTools ?? [],
    isLoading: auditQuery.isLoading,
    isFetching: auditQuery.isFetching,
    purgeMutation,
  };
}
