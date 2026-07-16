import {
  createAgentAccessToken,
  type CreateAgentAccessTokenInput,
  deleteAgentAccessToken,
  listAgentAccessTokens,
  logger,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

export function useAccessTokens() {
  const queryClient = useQueryClient();

  const tokensQuery = useQuery({
    queryKey: [QueryKeys.AGENT_ACCESS_TOKENS],
    queryFn: listAgentAccessTokens,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateAgentAccessTokenInput) => createAgentAccessToken(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.AGENT_ACCESS_TOKENS] });
    },
    onError: (error) => {
      logger.error(`Error creating personal access token: ${String(error)}`);
      toast({
        title: "Failed to create token",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAgentAccessToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.AGENT_ACCESS_TOKENS] });
      toast({ title: "Token removed", variant: "success" });
    },
    onError: (error) => {
      logger.error(`Error removing personal access token: ${String(error)}`);
      toast({
        title: "Failed to remove token",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  return {
    tokens: tokensQuery.data ?? [],
    isLoading: tokensQuery.isLoading,
    createMutation,
    deleteMutation,
  };
}
