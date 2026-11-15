import {
  addonIcons,
  AddonFallbackIcon,
  type AddonIconComponent,
} from "@wealthfolio/ui/components/ui/addon-icons";
import { cn } from "@/lib/utils";
import React from "react";

const SVG_ICON_URL_PREFIX = "data:image/svg+xml";
const SVG_ICON_URL_MAX_LENGTH = 8192;

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

/** Whether `icon` is a custom addon icon the host can draw as a mask. */
function isAddonSvgIconUrl(icon: string) {
  return icon.startsWith(SVG_ICON_URL_PREFIX) && icon.length <= SVG_ICON_URL_MAX_LENGTH;
}

/**
 * Draws an addon's SVG data URL as a CSS mask over `currentColor`. A mask
 * image never runs scripts or loads external references, and the icon follows
 * the sidebar text color in both themes like the built-in icons.
 */
function AddonSvgIcon({ url, className }: { url: string; className: string }) {
  // Percent-encode the characters that would end or break a quoted CSS url().
  const safeUrl = url.replace(/["\\\n\r]/g, encodeURIComponent);
  const mask = `url("${safeUrl}") center / contain no-repeat`;
  return (
    <span
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{ mask, WebkitMask: mask }}
    />
  );
}

export function resolveNavigationIcon(icon: React.ReactNode, className: string) {
  if (!icon) {
    return <AddonFallbackIcon className={className} />;
  }

  // Addon items: SVG data URL, or a name resolved against the curated set.
  if (typeof icon === "string") {
    if (isAddonSvgIconUrl(icon)) {
      return <AddonSvgIcon url={icon} className={className} />;
    }
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
