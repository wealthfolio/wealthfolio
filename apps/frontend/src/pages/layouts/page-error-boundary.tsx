import { ErrorBoundary } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Keeps the app usable when a page fails to render: the error shows in the page
 * area, navigation stays available, and the next route starts afresh.
 */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onDashboard = pathname === "/" || pathname === "/dashboard";
  return (
    <ErrorBoundary
      key={pathname}
      variant="page"
      onGoHome={onDashboard ? undefined : () => navigate("/")}
    >
      {children}
    </ErrorBoundary>
  );
}
