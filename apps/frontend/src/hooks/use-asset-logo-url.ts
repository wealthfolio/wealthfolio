import { useQuery } from "@tanstack/react-query";
import { getAssetLogoUrl } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Asset } from "@/lib/types";

export function useAssetLogoUrl(asset: Pick<Asset, "id" | "customLogoFilename"> | undefined) {
  return useQuery<string | null, Error>({
    queryKey: [QueryKeys.ASSET_DATA, asset?.id, "logo", asset?.customLogoFilename],
    queryFn: () => getAssetLogoUrl(asset),
    enabled: !!asset?.customLogoFilename,
  });
}
