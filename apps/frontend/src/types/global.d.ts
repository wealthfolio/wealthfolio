// Global ambient type declarations to avoid `any` for globals
declare global {
  // Additional globals (available in dev)
  // oxlint-disable-next-line no-var
  var __ADDON_DEV__: unknown;
  // oxlint-disable-next-line no-var
  var debugAddons: unknown;
  // oxlint-disable-next-line no-var
  var discoverAddons: unknown;
  // oxlint-disable-next-line no-var
  var reloadAddons: unknown;
}

export {};
