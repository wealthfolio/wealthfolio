import { QueryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import { hasVerifiedTotpFactor } from "../lib/mfa";
import { useWealthfolioConnect } from "../providers/wealthfolio-connect-provider";

/** Whether the signed-in account has two-factor authentication on. */
export function useTwoFactorStatus() {
  const { isConnected, user, fetchMfaEnabled } = useWealthfolioConnect();
  const query = useQuery({
    queryKey: [QueryKeys.CONNECT_TWO_FACTOR, user?.id],
    queryFn: fetchMfaEnabled,
    enabled: isConnected && !!user,
    staleTime: 30_000,
    // 2FA is turned on in the browser; pick up the change when the user comes back.
    refetchOnWindowFocus: true,
  });
  return {
    // The sign-in session lists the factors too; use it until the account is read.
    isEnabled: query.data ?? hasVerifiedTotpFactor(user),
    isKnown: query.isSuccess,
  };
}
