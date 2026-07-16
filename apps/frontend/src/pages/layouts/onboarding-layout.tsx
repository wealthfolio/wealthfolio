import { ErrorBoundary } from "@wealthfolio/ui";
import { Outlet } from "react-router-dom";

const OnboardingLayout = () => {
  return (
    <div className="bg-background scan-hide-target flex min-h-screen">
      <div className="relative flex h-screen w-full overflow-auto">
        <ErrorBoundary>
          <main className="flex w-full flex-1 flex-col">
            <div data-tauri-drag-region="true" className="draggable h-6 w-full"></div>
            <div className="flex-1 overflow-auto">
              <Outlet />
            </div>
          </main>
        </ErrorBoundary>
      </div>
    </div>
  );
};

export { OnboardingLayout };
