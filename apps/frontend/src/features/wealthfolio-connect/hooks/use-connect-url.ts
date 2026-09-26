import { usePlatform } from "@/hooks/use-platform";
import { buildConnectUrl, type ConnectLinkPlacement } from "../lib/connect-url";

export function useConnectUrl(placement: ConnectLinkPlacement, plan?: string) {
  const { isWeb, isMobile, loading } = usePlatform();
  return buildConnectUrl({ isWeb, isMobile: loading ? undefined : isMobile }, placement, plan);
}
