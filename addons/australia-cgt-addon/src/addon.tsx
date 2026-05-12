import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";
import { AustraliaCgtPage } from "./pages/australia-cgt-page";

const enable: AddonEnableFunction = (ctx) => {
  ctx.api.logger.info("Australia CGT Planner addon is being enabled");

  const cleanupTasks: Array<() => void> = [];

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
    [...cleanupTasks].reverse().forEach((cleanup) => cleanup());
    throw error;
  }

  ctx.onDisable(() => {
    [...cleanupTasks].reverse().forEach((cleanup) => cleanup());
    ctx.api.logger.info("Australia CGT Planner addon disabled");
  });
};

export default enable;
