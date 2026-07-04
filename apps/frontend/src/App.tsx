import { isWeb } from "@/adapters";
import { setAddonQueryClient } from "@/addons/addons-runtime-context";
import { loadAllAddons } from "@/addons/addons-loader";
import { AuthGate, AuthProvider, useAuth } from "@/context/auth-context";
import { EventDialogProvider } from "@/features/spending/components/event-dialog-provider";
import { WealthfolioConnectProvider } from "@/features/wealthfolio-connect";
import { SettingsProvider } from "@/lib/settings-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@wealthfolio/ui";
import { useEffect, useRef, useState } from "react";
import { PrivacyProvider } from "./context/privacy-context";
import { LoginPage } from "./pages/auth/login-page";
import { AppRoutes } from "./routes";

// In web mode, addon discovery requires an authenticated session, so addons
// cannot be loaded at startup (see main.tsx). This loads them once the session
// is authenticated. Desktop loads at startup and is handled in main.tsx.
function AddonRuntimeLoader() {
  const { isAuthenticated } = useAuth();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!isWeb || !isAuthenticated || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void loadAllAddons();
  }, [isAuthenticated]);

  return null;
}

function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            staleTime: 5 * 60 * 1000,
            retry: false,
          },
        },
      }),
  );

  const isWebEnv = isWeb;

  setAddonQueryClient(queryClient as unknown as Parameters<typeof setAddonQueryClient>[0]);

  const routedContent = isWebEnv ? (
    <AuthGate fallback={<LoginPage />}>
      <AppRoutes />
    </AuthGate>
  ) : (
    <AppRoutes />
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AddonRuntimeLoader />
        <WealthfolioConnectProvider>
          <PrivacyProvider>
            <SettingsProvider>
              <TooltipProvider>
                <EventDialogProvider>{routedContent}</EventDialogProvider>
              </TooltipProvider>
            </SettingsProvider>
          </PrivacyProvider>
        </WealthfolioConnectProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
