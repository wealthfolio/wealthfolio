// Global ambient type declarations to avoid `any` for globals
declare global {
  interface Window {
    // Tauri global injected by the desktop runtime
    __TAURI__?: unknown;
  }

  // Additional globals (available in dev)
  // eslint-disable-next-line no-var
  var __ADDON_DEV__: unknown;
  // eslint-disable-next-line no-var
  var debugAddons: unknown;
  // eslint-disable-next-line no-var
  var discoverAddons: unknown;
  // eslint-disable-next-line no-var
  var reloadAddons: unknown;
}

export {};
