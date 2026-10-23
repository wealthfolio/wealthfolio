import { RestoredPortfolioNotice } from "@/features/database-recovery/restored-portfolio-notice";
import { BrowserRouter, Route, Routes, matchPath, useLocation } from "react-router-dom";

import { AppLayout } from "@/pages/layouts/app-layout";
import { OnboardingLayout } from "@/pages/layouts/onboarding-layout";

import AuthCallbackPage from "@/features/wealthfolio-connect/pages/auth-callback-page";
import useNavigationEventListener from "@/hooks/use-navigation-event-listener";
import OnboardingPage from "./pages/onboarding/onboarding-page";

function NavigationEventBridge() {
  useNavigationEventListener();
  return null;
}

/** Pages shown without the app's navigation. */
const STANDALONE_PATHS = ["/auth/callback", "/onboarding"];

/**
 * Every other path renders the app shell, which routes its own pages
 * (`AppScreenRoutes`). The shell is not a route itself, so a page's params are
 * only the ones its own path declares.
 */
function AppRouteSwitch() {
  const { pathname } = useLocation();
  if (!STANDALONE_PATHS.some((path) => matchPath(path, pathname))) {
    return <AppLayout />;
  }

  return (
    <Routes>
      {/* QR Scanner - No layout for fullscreen camera access */}
      {/* <Route path="/qr-scanner" element={<QRScannerPage />} /> */}

      {/* Auth callback - No layout needed */}
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      {/* Onboarding with dedicated layout */}
      <Route path="/onboarding" element={<OnboardingLayout />}>
        <Route index element={<OnboardingPage />} />
      </Route>
    </Routes>
  );
}

export function AppRoutes() {
  return (
    // Navigations render at once, not in a transition: the first tap's screen is
    // on its way (and taps are off) before a second tap can push it again.
    <BrowserRouter useTransitions={false}>
      <NavigationEventBridge />
      <RestoredPortfolioNotice />
      <AppRouteSwitch />
    </BrowserRouter>
  );
}
