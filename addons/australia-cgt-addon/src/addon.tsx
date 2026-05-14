import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";
import { AustraliaCgtPage } from "./pages/australia-cgt-page";

type CleanupTask = () => void;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function runCleanupTasks(ctx: AddonContext, cleanupTasks: CleanupTask[]) {
  for (const cleanup of [...cleanupTasks].reverse()) {
    try {
      cleanup();
    } catch (error) {
      ctx.api.logger.error("Error cleaning up Australia CGT Planner addon: " + errorMessage(error));
    }
  }
}

const enable: AddonEnableFunction = (ctx) => {
  ctx.api.logger.info("Australia CGT Planner addon is being enabled");

  const cleanupTasks: CleanupTask[] = [];

  try {
    const sidebarItem = ctx.sidebar.addItem({
      id: "australia-cgt-addon",
      label: "Australia CGT Planner",
      icon: <Icons.Percent className="h-5 w-5" />,
      route: "/addons/australia-cgt",
      order: 210,
    });
    cleanupTasks.push(() => sidebarItem.remove());

    const AustraliaCgtWrapper = () => {
      const sharedQueryClient = ctx.api.query.getClient() as QueryClient;
      return (
        <QueryClientProvider client={sharedQueryClient}>
          <AustraliaCgtPage ctx={ctx} />
        </QueryClientProvider>
      );
    };

    ctx.router.add({
      path: "/addons/australia-cgt",
      component: React.lazy(() =>
        Promise.resolve({
          default: AustraliaCgtWrapper,
        }),
      ),
    });
  } catch (error) {
    ctx.api.logger.error("Failed to initialize Australia CGT Planner addon: " + errorMessage(error));
    runCleanupTasks(ctx, cleanupTasks);
    throw error;
  }

  ctx.onDisable(() => {
    runCleanupTasks(ctx, cleanupTasks);
    ctx.api.logger.info("Australia CGT Planner addon disabled");
  });
};

export default enable;
