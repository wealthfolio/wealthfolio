import { logger } from "@/adapters";
import type { AddonManifest } from "@wealthfolio/addon-sdk";

import {
  scopedKey,
  toRouterPath,
  triggerNavigationUpdate,
  type DynamicNavItem,
  type DynamicRouteEntry,
} from "./addons-runtime-context";

/**
 * Durable contribution layer.
 *
 * Ingests each installed addon's `manifest.contributes` at boot WITHOUT
 * executing addon code: `contributes.routes` become durable
 * `DynamicRouteEntry`-shaped records (a route is legal without any link —
 * deep-link only), and `contributes.links["sidebar"]` become durable
 * `DynamicNavItem`-shaped records pointing at those routes.
 * {@link ./addons-runtime-context} merges both with its transient runtime
 * registrations. Entries here survive a runtime stop (a stopped-but-enabled
 * addon keeps its nav so it can be re-activated) and are cleared only on
 * disable/uninstall (or a full re-ingest on reload).
 *
 * Only the `"sidebar"` slot is consumed today; unknown slot keys are future
 * host surfaces and are ignored here (they still round-trip through install).
 *
 * The host owns each declarative route namespace: manifest paths are relative
 * suffixes mounted below `/addons/<addon-id>`. Invalid entries are logged and
 * skipped so one bad entry cannot kill boot. Rust performs the same validation
 * at install; the re-check here is defense-in-depth for dev manifests that
 * never passed through the Rust parser.
 */

/** The only link slot the host consumes today. */
const SIDEBAR_SLOT = "sidebar";

// Both maps are keyed by `scopedKey(addonId, <route id | effective link id>)`.
const durableNavItems = new Map<string, DynamicNavItem>();
const durableRoutes = new Map<string, DynamicRouteEntry>();

function isSafeAddonIdSegment(addonId: string) {
  return (
    addonId === addonId.trim() &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(addonId) &&
    !/^\.+$/.test(addonId)
  );
}

function normalizeContributedRoutePath(path: unknown): string | null {
  if (path == null) {
    return "";
  }
  if (typeof path !== "string" || path !== path.trim()) {
    return null;
  }
  if (path === "") {
    return "";
  }
  if (
    path.startsWith("/") ||
    /[\\?#%]/.test(path) ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
}

/**
 * Ingest an addon's declarative contributions (routes + sidebar links) into
 * the durable layer. Does not execute addon code and does not boot an iframe.
 * Used for both installed addons (at load) and dev-server addons (on dev load),
 * so a scaffolded addon's manifest-declared sidebar link appears in either mode.
 */
export function ingestAddonContributions(addonId: string, manifest: AddonManifest): void {
  const routes = manifest.contributes?.routes ?? [];
  const links = manifest.contributes?.links ?? {};
  if (routes.length === 0 && Object.keys(links).length === 0) {
    return;
  }
  if (!isSafeAddonIdSegment(addonId)) {
    logger.warn(`Addon '${addonId}' has an invalid route namespace; skipping contributions.`);
    return;
  }

  let changed = false;

  // Routes first: they are the durable pages links resolve against. A route is
  // ingested regardless of links — a route with no link is deep-link only.
  const ingestedRoutes = new Map<string, DynamicRouteEntry>();
  const ingestedPaths = new Set<string>();
  for (const route of routes) {
    const routeId = String(route?.id ?? "").trim();

    if (!routeId) {
      logger.warn(`Addon '${addonId}' contributes a route with an empty id; skipping.`);
      continue;
    }

    if (ingestedRoutes.has(routeId)) {
      logger.warn(
        `Addon '${addonId}' contributes duplicate route id '${routeId}'; skipping the duplicate.`,
      );
      continue;
    }

    const relativePath = normalizeContributedRoutePath(route?.path);
    if (relativePath === null) {
      logger.warn(`Addon '${addonId}' route '${routeId}' has an invalid relative path; skipping.`);
      continue;
    }

    const pathKey = relativePath.toLowerCase();
    if (ingestedPaths.has(pathKey)) {
      logger.warn(
        `Addon '${addonId}' contributes duplicate route path '${relativePath}'; skipping the duplicate.`,
      );
      continue;
    }
    ingestedPaths.add(pathKey);

    const href = relativePath ? `/addons/${addonId}/${relativePath}` : `/addons/${addonId}`;
    const entry: DynamicRouteEntry = {
      addonId,
      href,
      path: toRouterPath(href),
      routeId,
    };
    ingestedRoutes.set(routeId, entry);
    durableRoutes.set(scopedKey(addonId, routeId), entry);
    changed = true;
  }

  // Sidebar links become durable nav items pointing at declared routes.
  // Other slots are future host surfaces — parsed and persisted, but ignored.
  const unknownSlots = Object.keys(links).filter((slot) => slot !== SIDEBAR_SLOT);
  if (unknownSlots.length > 0) {
    logger.debug(
      `Addon '${addonId}' contributes links in unconsumed slot(s) ${unknownSlots
        .map((slot) => `'${slot}'`)
        .join(", ")}; ignoring.`,
    );
  }

  const seenLinkIds = new Set<string>();
  for (const link of links[SIDEBAR_SLOT] ?? []) {
    const routeRef = String(link?.route ?? "").trim();
    const label = String(link?.label ?? "").trim();

    if (!routeRef || !label) {
      logger.warn(
        `Addon '${addonId}' contributes a sidebar link with an empty route/label; skipping.`,
      );
      continue;
    }

    const linkId = String(link?.id ?? "").trim() || routeRef;
    if (seenLinkIds.has(linkId)) {
      logger.warn(
        `Addon '${addonId}' contributes duplicate sidebar link id '${linkId}'; skipping the duplicate.`,
      );
      continue;
    }
    seenLinkIds.add(linkId);

    const route = ingestedRoutes.get(routeRef);
    if (!route) {
      logger.warn(
        `Addon '${addonId}' sidebar link '${linkId}' references undeclared route '${routeRef}'; skipping.`,
      );
      continue;
    }

    // Backfill the referenced route's display title from its nav label.
    if (!route.title) {
      route.title = label;
    }

    durableNavItems.set(scopedKey(addonId, linkId), {
      addonId,
      href: route.href,
      icon: typeof link.icon === "string" ? link.icon : undefined,
      id: scopedKey(addonId, linkId),
      order: typeof link.order === "number" ? link.order : 999,
      title: label,
    });
    changed = true;
  }

  if (changed) {
    triggerNavigationUpdate();
  }
}

/** Sorted durable nav items (same shape/sort contract as the transient layer). */
export function getDurableNavItems(): DynamicNavItem[] {
  return Array.from(durableNavItems.values()).sort((a, b) => a.order - b.order);
}

/** Sorted durable routes (same shape/sort contract as the transient layer). */
export function getDurableRoutes(): DynamicRouteEntry[] {
  return Array.from(durableRoutes.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Remove one addon's durable contributions. Call on disable/uninstall/manifest
 * update — NOT on plain runtime stop (a stopped-but-enabled addon keeps its nav
 * so it can be re-activated by lazy boot).
 */
export function clearAddonContributions(addonId: string): void {
  let changed = false;
  for (const [key, item] of durableNavItems) {
    if (item.addonId === addonId) {
      durableNavItems.delete(key);
      changed = true;
    }
  }
  for (const [key, route] of durableRoutes) {
    if (route.addonId === addonId) {
      durableRoutes.delete(key);
      changed = true;
    }
  }
  if (changed) {
    triggerNavigationUpdate();
  }
}

/**
 * Drop the entire durable registry. Used before a full re-ingest on reload so a
 * disabled/uninstalled addon that is no longer discovered leaves no stale nav.
 */
export function clearAllContributions(): void {
  const hadEntries = durableNavItems.size > 0 || durableRoutes.size > 0;
  durableNavItems.clear();
  durableRoutes.clear();
  if (hadEntries) {
    triggerNavigationUpdate();
  }
}
