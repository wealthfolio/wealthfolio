import { ProfileShell } from "@/features/profiles/profile-shell";
import { NativeDatabaseGate } from "@/features/database-recovery/native-database-gate";
import { isWeb } from "@/adapters";
import { AddonRuntimeLoader } from "@/addons/addon-runtime-loader";
import { setAddonQueryClient } from "@/addons/addons-runtime-context";
import { AssetLogoRegistrySync } from "@/components/asset-logo-registry-sync";
import { Toaster } from "@/components/sonner";
import { AuthGate, AuthProvider } from "@/context/auth-context";
import { EventDialogProvider } from "@/features/spending/components/event-dialog-provider";
import { WealthfolioConnectProvider } from "@/features/wealthfolio-connect";
import { SettingsProvider } from "@/lib/settings-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@wealthfolio/ui";
import { MotionConfig } from "motion/react";
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

  setAddonQueryClient(queryClient as unknown as Parameters<typeof setAddonQueryClient>[0]);

  const content = (
    <SettingsProvider>
      <WealthfolioConnectProvider>
        <PrivacyProvider>
          <TooltipProvider>
            <Toaster mobileOffset={{ top: "68px" }} closeButton expand={false} />
            <AddonRuntimeLoader />
            <EventDialogProvider>
              <AssetLogoRegistrySync />
              <AppRoutes />
            </EventDialogProvider>
          </TooltipProvider>
        </PrivacyProvider>
      </WealthfolioConnectProvider>
    </SettingsProvider>
  );

  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          {isWebEnv ? (
            <AuthGate fallback={<LoginPage />}>
              <ProfileShell>
                <NativeDatabaseGate>{content}</NativeDatabaseGate>
              </ProfileShell>
            </AuthGate>
          ) : (
            <ProfileShell>
              <NativeDatabaseGate>{content}</NativeDatabaseGate>
            </ProfileShell>
          )}
        </AuthProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}

export default App;
