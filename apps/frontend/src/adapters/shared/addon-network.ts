import type { AddonNetworkRequest, AddonNetworkResponse } from "../types";
import { invoke } from "./platform";

export const addonNetworkRequest = async (
  addonId: string,
  request: AddonNetworkRequest,
): Promise<AddonNetworkResponse> => {
  return invoke<AddonNetworkResponse>("addon_network_request", {
    addonId,
    request,
  });
};
