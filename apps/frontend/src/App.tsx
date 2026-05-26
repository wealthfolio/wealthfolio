import { isWeb } from "@/adapters";
import { AuthGate, AuthProvider } from "@/context/auth-context";
import { EventDialogProvider } from "@/features/spending/components/event-dialog-provider";
import { WealthfolioConnectProvider } from "@/features/wealthfolio-connect";
import { SettingsProvider } from "@/lib/settings-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@wealthfolio/ui";
import { useState } from "react";
import { PrivacyProvider } from "./context/privacy-context";
import { LoginPage } from "./pages/auth/login-page";
import { AppRoutes } from "./routes";

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

  // Make QueryClient available globally for addons
  window.__wealthfolio_query_client__ = queryClient;

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
