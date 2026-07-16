import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/pages/layouts/app-layout";
import { OnboardingLayout } from "@/pages/layouts/onboarding-layout";
import SettingsLayout from "@/pages/settings/settings-layout";

import {
  getDynamicRoutes,
  subscribeToNavigationUpdates,
  type DynamicRouteEntry,
} from "@/addons/addons-runtime-context";
import { AddonIframeRoute } from "@/addons/iframe/addon-iframe-route";
import AuthCallbackPage from "@/features/wealthfolio-connect/pages/auth-callback-page";
import ConnectPage from "@/features/wealthfolio-connect/pages/connect-page";
import useNavigationEventListener from "@/hooks/use-navigation-event-listener";
import ActivityManagerPage from "@/pages/activity/activity-manager-page";
import ActivityPage from "@/pages/activity/activity-page";
import ActivityImportPage from "@/pages/activity/import/activity-import-page";
import AssetsPage from "@/pages/asset/assets-page";
import PortfolioPage from "@/pages/dashboard/portfolio-page";
import HoldingsPage from "@/pages/holdings/holdings-page";
import IncomePage from "@/pages/income/income-page";
import PortfolioInsightsPage from "@/pages/insights/portfolio-insights";
import NotFoundPage from "@/pages/not-found";
import PerformancePage from "@/pages/performance/performance-page";
import SettingsAccountsPage from "@/pages/settings/accounts/accounts-page";
import PortfoliosPage from "@/pages/settings/portfolios/portfolios-page";
import SettingsAppearancePage from "@/pages/settings/appearance/appearance-page";
import AccountPage from "./pages/account/account-page";
import AiAssistantPage from "./pages/ai-assistant/ai-assistant-page";
import AssetProfilePage from "./pages/asset/asset-profile-page";
import HealthPage from "./pages/health/health-page";
import OnboardingPage from "./pages/onboarding/onboarding-page";
import AboutSettingsPage from "./pages/settings/about/about-page";
import AddonSettingsPage from "./pages/settings/addons/addon-settings";
import AgentAccessPage from "./pages/settings/agent-access/agent-access-page";
import AiProvidersPage from "./pages/settings/ai-providers/ai-providers-page";
import ContributionLimitPage from "./pages/settings/contribution-limits/contribution-limits-page";
import ExportSettingsPage from "./pages/settings/exports/exports-page";
import GeneralSettingsPage from "./pages/settings/general/general-page";
import MarketDataImportPage from "./pages/settings/market-data/market-data-import-page";
import MarketDataSettingsPage from "./pages/settings/market-data/market-data-settings";
import TaxonomiesPage from "./pages/settings/taxonomies/taxonomies-page";
import ConnectSettingsPage from "./pages/settings/wealthfolio-connect/connect-settings-page";
import SpendingInsightsPage from "./features/spending/pages/spending-insights-page";
import SpendingBudgetPage from "./features/spending/pages/spending-budget-page";
import SpendingSettingsPage from "./pages/settings/spending/spending-settings-page";
import SpendingSettingsCategoriesPage from "./pages/settings/spending/categories/spending-categories-page";
import SpendingSettingsEventsPage from "./pages/settings/spending/events/spending-events-page";
import SpendingSettingsRulesPage from "./pages/settings/spending/rules/spending-rules-page";
import SpendingSetupPage from "./pages/settings/spending/setup/spending-setup-page";
import GoalsDashboardPage from "@/features/goals/pages/goals-dashboard-page";
import GoalNewPage from "@/features/goals/pages/goal-new-page";
import GoalDetailPage from "@/features/goals/pages/goal-detail-page";
import GoalRetirementGuidePage from "@/features/goals/pages/goal-retirement-guide-page";

function NavigationEventBridge() {
  useNavigationEventListener();
  return null;
}

export function AppRoutes() {
  const [dynamicRoutes, setDynamicRoutes] = useState<DynamicRouteEntry[]>([]);

  // Subscribe to dynamic route updates
  useEffect(() => {
    const updateRoutes = () => {
      setDynamicRoutes(getDynamicRoutes());
    };

    // Initial load
    updateRoutes();

    // Subscribe to updates
    const unsubscribe = subscribeToNavigationUpdates(updateRoutes);

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <BrowserRouter>
      <NavigationEventBridge />
      <Routes>
        {/* QR Scanner - No layout for fullscreen camera access */}
        {/* <Route path="/qr-scanner" element={<QRScannerPage />} /> */}

        {/* Auth callback - No layout needed */}
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        {/* Onboarding with dedicated layout */}
        <Route path="/onboarding" element={<OnboardingLayout />}>
          <Route index element={<OnboardingPage />} />
        </Route>

        {/* Main app with sidebar */}
        <Route path="/" element={<AppLayout />}>
          <Route index element={<PortfolioPage />} />
          <Route path="dashboard" element={<PortfolioPage />} />
          <Route path="activities" element={<ActivityPage />} />
          <Route path="activities/manage" element={<ActivityManagerPage />} />
          <Route path="holdings" element={<HoldingsPage />} />
          <Route path="holdings/:assetId" element={<AssetProfilePage />} />
          <Route path="import" element={<ActivityImportPage />} />
          <Route path="accounts/:id" element={<AccountPage />} />
          <Route path="income" element={<IncomePage />} />
          <Route path="performance" element={<PerformancePage />} />
          <Route path="insights" element={<PortfolioInsightsPage />} />
          <Route path="health" element={<HealthPage />} />
          <Route path="assistant" element={<AiAssistantPage />} />
          <Route path="connect" element={<ConnectPage />} />
          <Route
            path="allocation-targets"
            element={<Navigate to="/insights?tab=overview" replace />}
          />
          <Route path="goals" element={<GoalsDashboardPage />} />
          <Route path="goals/new" element={<GoalNewPage />} />
          <Route path="goals/:goalId/guide" element={<GoalRetirementGuidePage />} />
          <Route path="goals/:goalId" element={<GoalDetailPage />} />
          <Route path="spending/insights" element={<SpendingInsightsPage />} />
          <Route path="spending/budget" element={<SpendingBudgetPage />} />
          {/* Dynamic addon routes */}
          {dynamicRoutes.map(({ path, addonId, routeId }) => (
            <Route
              key={`${addonId}:${routeId}`}
              path={path}
              element={<AddonIframeRoute addonId={addonId} routeId={routeId} />}
            />
          ))}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<GeneralSettingsPage />} />
            <Route path="general" element={<GeneralSettingsPage />} />
            <Route path="accounts" element={<SettingsAccountsPage />} />
            <Route path="portfolios" element={<PortfoliosPage />} />
            <Route path="appearance" element={<SettingsAppearancePage />} />
            <Route path="about" element={<AboutSettingsPage />} />
            <Route path="exports" element={<ExportSettingsPage />} />
            <Route path="contribution-limits" element={<ContributionLimitPage />} />
            <Route path="spending" element={<SpendingSettingsPage />} />
            <Route path="spending/categories" element={<SpendingSettingsCategoriesPage />} />
            <Route path="spending/events" element={<SpendingSettingsEventsPage />} />
            <Route path="spending/rules" element={<SpendingSettingsRulesPage />} />
            <Route path="spending/setup" element={<SpendingSetupPage />} />
            <Route path="market-data" element={<MarketDataSettingsPage />} />
            <Route path="market-data/import" element={<MarketDataImportPage />} />
            <Route path="securities" element={<AssetsPage />} />
            <Route path="taxonomies" element={<TaxonomiesPage />} />
            <Route path="connect" element={<ConnectSettingsPage />} />
            <Route path="ai-providers" element={<AiProvidersPage />} />
            <Route path="agent-access" element={<AgentAccessPage />} />
            <Route path="addons" element={<AddonSettingsPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
