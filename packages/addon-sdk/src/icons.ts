/**
 * Icon names an addon may use for its sidebar item.
 *
 * The sidebar is host chrome, so the host draws the icon from this fixed set of
 * duotone Phosphor icons. An addon can't pass a component across the sandbox
 * boundary; for a custom shape use an {@link AddonSvgIconUrl}. (Inside your own
 * route/page you can render any icon you like.) Matching at runtime is case-
 * and separator-insensitive (`"ChartLine"`, `"chart-line"`, and `"chartline"`
 * all resolve the same), but this canonical
 * kebab-case list is what the type checker accepts. Unknown names render a
 * neutral fallback icon rather than erroring.
 */
export const ADDON_ICON_NAMES = [
  // Money
  'wallet',
  'coins',
  'dollar',
  'dollar-circle',
  'bank',
  'credit-card',
  'piggy-bank',
  'receipt',
  'invoice',
  'hand-coins',
  'hand-deposit',
  'vault',
  'chart-line-up',
  'chart-line',
  'trend-up',
  'trend-down',
  'percent',
  'scales',
  'calculator',
  // Charts & analytics
  'chart-bar',
  'chart-pie',
  'chart-pie-slice',
  'chart-donut',
  'gauge',
  'target',
  'presentation',
  // Assets
  'house',
  'buildings',
  'car',
  'airplane',
  'bicycle',
  'diamond',
  'bitcoin',
  'storefront',
  'briefcase',
  'package',
  'cube',
  // General
  'star',
  'heart',
  'gift',
  'trophy',
  'medal',
  'lightning',
  'sparkle',
  'bell',
  'tag',
  'bookmark',
  'flag',
  'fire',
  'rocket',
  'lightbulb',
  'graduation-cap',
  'barbell',
  'fork-knife',
  'coffee',
  'wine',
  'shopping-cart',
  'shopping-bag',
  'basket',
  // Time & place
  'calendar',
  'calendar-dots',
  'calendar-check',
  'clock',
  'hourglass',
  'globe',
  'map-pin',
  'compass',
  // Productivity
  'folder',
  'files',
  'notebook',
  'clipboard-text',
  'list-checks',
  'sliders',
  'wrench',
  'toolbox',
  'puzzle-piece',
  'plugs-connected',
  'app-window',
  'squares-four',
  'stack',
  'kanban',
] as const;

/** Union of every valid addon sidebar icon name. */
export type AddonIconName = (typeof ADDON_ICON_NAMES)[number];

/**
 * A custom sidebar icon as an SVG data URL, e.g.
 * `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>`.
 *
 * The host uses the SVG only as a CSS mask, so only its shape (alpha) counts:
 * the icon takes the sidebar's text color in both themes, and scripts or
 * external references inside the SVG never run. URLs longer than 8,192
 * characters render the fallback icon.
 */
export type AddonSvgIconUrl = `data:image/svg+xml${string}`;

/** Sidebar icon value: a host icon name or a custom SVG data URL. */
export type AddonIcon = AddonIconName | AddonSvgIconUrl;
