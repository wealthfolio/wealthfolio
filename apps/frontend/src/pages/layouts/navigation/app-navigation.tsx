import { getDynamicNavItems, subscribeToNavigationUpdates } from "@/addons/addons-runtime-context";
import { useI18n } from "@/i18n/i18n-provider";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useEffect, useState } from "react";

export interface NavLink {
  title: string;
  href: string;
  icon?: React.ReactNode;
  keywords?: string[];
  label?: string; // Optional descriptive label for launcher/search
}

export interface NavigationProps {
  primary: NavLink[];
  secondary?: NavLink[];
  addons?: NavLink[];
}

export function useNavigation() {
  const [dynamicItems, setDynamicItems] = useState<NavigationProps["addons"]>([]);
  const { t } = useI18n();

  // Subscribe to navigation updates from addons
  useEffect(() => {
    const updateDynamicItems = () => {
      const itemsFromRuntime = getDynamicNavItems();
      setDynamicItems(itemsFromRuntime);
    };

    // Initial load
    updateDynamicItems();

    // Subscribe to updates
    const unsubscribe = subscribeToNavigationUpdates(updateDynamicItems);

    return () => {
      unsubscribe();
    };
  }, []);

  // Spending lives entirely on the dashboard tab (and its deep-linked pages);
  // no top-level nav entry. Combine static navigation items with addons.
  const staticNavigation: NavigationProps = {
    primary: [
      {
        icon: <Icons.Dashboard className="size-6" />,
        title: t("navigation.dashboard.title"),
        href: "/dashboard",
        keywords: ["home", "overview", "summary", "仪表盘", "首页", "总览"],
        label: t("navigation.dashboard.label"),
      },
      {
        icon: <Icons.Insight className="size-6" />,
        title: t("navigation.insights.title"),
        href: "/insights",
        keywords: ["insights", "analytics", "洞察", "分析"],
        label: t("navigation.insights.label"),
      },
      {
        icon: <Icons.Holdings className="size-6" />,
        title: t("navigation.holdings.title"),
        href: "/holdings",
        keywords: [
          "holdings",
          "portfolio",
          "assets",
          "positions",
          "stocks",
          "持仓",
          "资产",
          "股票",
        ],
        label: t("navigation.holdings.label"),
      },
      {
        icon: <Icons.Activity className="size-6" />,
        title: t("navigation.activities.title"),
        href: "/activities",
        keywords: ["transactions", "trades", "history", "活动", "交易", "历史"],
        label: t("navigation.activities.label"),
      },
      {
        icon: <Icons.Goals className="size-6" />,
        title: t("navigation.goals.title"),
        href: "/goals",
        keywords: [
          "goals",
          "fire",
          "retire",
          "retirement",
          "savings",
          "planner",
          "目标",
          "退休",
          "储蓄",
        ],
        label: t("navigation.goals.label"),
      },
      {
        icon: <Icons.Sparkles className="size-6" />,
        title: t("navigation.assistant.title"),
        href: "/assistant",
        keywords: ["ai", "assistant", "chat", "help", "ask", "助手", "聊天", "帮助"],
        label: t("navigation.assistant.label"),
      },
    ],
    secondary: [
      {
        icon: <Icons.Settings className="size-6" />,
        title: t("navigation.settings.title"),
        href: "/settings",
        keywords: ["preferences", "config", "configuration", "设置", "偏好", "配置"],
      },
    ],
  };

  const primary = [...staticNavigation.primary];

  const navigation: NavigationProps = {
    primary,
    secondary: staticNavigation.secondary,
    addons: dynamicItems,
  };

  return navigation;
}

export function isPathActive(pathname: string, href: string): boolean {
  if (!href) {
    return false;
  }

  const ensureLeadingSlash = href.startsWith("/") ? href : `/${href}`;
  const normalize = (value: string) => {
    if (value.length > 1 && value.endsWith("/")) {
      return value.slice(0, -1);
    }
    return value;
  };

  const normalizedHref = normalize(ensureLeadingSlash);
  const normalizedPath = normalize(pathname);

  if (normalizedHref === "/") {
    return normalizedPath === "/";
  }

  // Dashboard and Net Worth are grouped together
  if (normalizedHref === "/dashboard") {
    return (
      normalizedPath === "/" || normalizedPath === "/dashboard" || normalizedPath === "/net-worth"
    );
  }

  return normalizedPath === normalizedHref || normalizedPath.startsWith(`${normalizedHref}/`);
}
