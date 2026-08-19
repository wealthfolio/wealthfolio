import { ErrorBoundary } from "@wealthfolio/ui";
import { Outlet } from "react-router-dom";

const OnboardingLayout = () => {
  return (
    <div className="bg-background scan-hide-target flex h-screen overflow-hidden">
      <div className="relative flex h-full w-full overflow-hidden">
        <ErrorBoundary>
          <main className="flex min-h-0 w-full flex-1 flex-col">
            <div
              data-tauri-drag-region="true"
              className="draggable absolute inset-x-0 top-0 z-10 h-6"
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <Outlet />
            </div>
          </main>
        </ErrorBoundary>
      </div>
    </div>
  );
};

export { OnboardingLayout };
