import { useAuth } from "@/context/auth-context";
import { useEffect } from "react";
import { loadAllAddons } from "./addons-loader";

let hasStartedAddonRuntime = false;

export function AddonRuntimeLoader() {
  const { isAuthenticated, statusLoading } = useAuth();

  useEffect(() => {
    if (statusLoading || !isAuthenticated || hasStartedAddonRuntime) {
      return;
    }

    hasStartedAddonRuntime = true;
    void loadAllAddons();
  }, [statusLoading, isAuthenticated]);

  return null;
}
