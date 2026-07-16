import {
  addonIcons,
  AddonFallbackIcon,
  type AddonIconComponent,
} from "@wealthfolio/ui/components/ui/addon-icons";
import React from "react";

function normalizeIconKey(icon: string) {
  return icon.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Addon sidebar icons are named by a string (the sandbox can't pass a component
// across the iframe boundary), resolved against the curated duotone-Phosphor set
// in @wealthfolio/ui. Index by normalized name so matching is case- and
// separator-insensitive ("chart-line", "ChartLine", "chartline" all match).
const addonIconIndex: Record<string, AddonIconComponent> = Object.fromEntries(
  Object.entries(addonIcons).map(([name, Component]) => [normalizeIconKey(name), Component]),
);

export function resolveNavigationIcon(icon: React.ReactNode, className: string) {
  if (!icon) {
    return <AddonFallbackIcon className={className} />;
  }

  // Addon items: named icon string resolved against the curated set.
  if (typeof icon === "string") {
    const IconComponent = addonIconIndex[normalizeIconKey(icon)] ?? AddonFallbackIcon;
    return <IconComponent className={className} />;
  }

  // Native nav items: a React element or component is passed directly.
  if (React.isValidElement<{ className?: string }>(icon)) {
    return icon.props.className ? icon : React.cloneElement(icon, { className });
  }

  if (typeof icon === "function") {
    const IconComponent = icon as React.ComponentType<{ className?: string }>;
    return <IconComponent className={className} />;
  }

  return <AddonFallbackIcon className={className} />;
}
