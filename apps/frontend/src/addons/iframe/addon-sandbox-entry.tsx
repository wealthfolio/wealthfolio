import "@/globals.css";

import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { createHostDependencyModuleUrl, isHostDependencySpecifier } from "./host-dependencies";
import {
  clearAddonStyles,
  createCssModuleSource,
  installAddonCssFiles,
  installAddonStyle,
  isCssFile,
  type SandboxAddonFile,
} from "./addon-sandbox-styles";
import { applyHostTheme, type AddonThemeSnapshot } from "./addon-sandbox-theme";
import { rewriteModuleSpecifiers } from "./addon-module-rewriter";

const CHANNEL = "wealthfolio:addon-sandbox:v1";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
  params: Record<string, string | undefined>;
}

interface RouteRenderContext {
  root: HTMLElement;
  location: RouteLocation;
  onRendered?: () => void;
}

interface LegacyRouteConfig {
  id?: unknown;
  path?: unknown;
  title?: unknown;
  render?: unknown;
  component?: unknown;
}

interface SandboxMessage {
  channel?: string;
  addonId?: string;
  nonce?: string;
  type?: string;
  requestId?: string;
  code?: string;
  files?: SandboxAddonFile[];
  routeId?: string;
  location?: RouteLocation;
  ok?: boolean;
  result?: unknown;
  error?: string;
  subscriptionId?: string;
  payload?: unknown;
  theme?: AddonThemeSnapshot;
}

type RouteRenderer = (context: RouteRenderContext) => Promise<void> | void;

const init = new URLSearchParams(window.location.hash.slice(1));
const ADDON_ID = init.get("addonId") ?? "";
const NONCE = init.get("nonce") ?? "";
const rootElement = document.getElementById("addon-root");
const routes = new Map<string, RouteRenderer>();
const pending = new Map<string, PendingCall>();
const disableCallbacks = new Set<() => Promise<void> | void>();
const eventCallbacks = new Map<string, (payload: unknown) => void>();
let addonDisable: (() => Promise<void> | void) | undefined;
let addonCodeUrl: string | undefined;
let addonQueryClient: QueryClient | undefined;
let addonModuleUrls = new Map<string, string>();
let reactRouteRoot: ReactDOMClient.Root | undefined;

if (!ADDON_ID || !NONCE || !rootElement) {
  throw new Error("Invalid addon sandbox bootstrap parameters");
}

const root = rootElement;

function post(type: string, payload: Record<string, unknown> = {}) {
  parent.postMessage({ channel: CHANNEL, addonId: ADDON_ID, nonce: NONCE, type, ...payload }, "*");
}

function callHost(type: string, payload: Record<string, unknown> = {}) {
  const requestId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post(type, { requestId, ...payload });
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reportHostCallError(action: string, error: unknown) {
  const message = `${action} failed: ${formatError(error)}`;
  console.error(message);
  post("runtimeError", { error: message });
}

function reportLoadPhase(phase: string) {
  post("loadPhase", { phase });
}

// Resolve on the next paint, but with a timer fallback. Legacy `render` routes
// (which never call `onRendered`) rely on this to signal completion — and a
// cold route render happens while the host has the iframe `visibility: hidden`,
// where `requestAnimationFrame` is throttled/paused (notably in WKWebView). A
// pure rAF wait would then never resolve, so the host's render times out and
// the addon shows "failed to load". The fallback guarantees progress; rAF still
// wins when the frame is visible, keeping the paint-synced reveal.
function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 50);
  });
}

function normalizeModulePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function dirname(path: string) {
  const normalizedPath = normalizeModulePath(path);
  const index = normalizedPath.lastIndexOf("/");
  return index === -1 ? "" : normalizedPath.slice(0, index);
}

function resolveModulePath(importerPath: string, specifier: string) {
  const normalizedSpecifier = normalizeModulePath(specifier);
  if (!normalizedSpecifier.startsWith(".")) {
    return normalizedSpecifier;
  }

  const basePath = dirname(importerPath);
  const parts = `${basePath}/${normalizedSpecifier}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

function stripSourceMapReferences(code: string) {
  return code.replace(/\/\/# sourceMappingURL=.*/g, "");
}

function getModuleBasename(path: string) {
  const normalizedPath = normalizeModulePath(path);
  const index = normalizedPath.lastIndexOf("/");
  return index === -1 ? normalizedPath : normalizedPath.slice(index + 1);
}

function createAddonModuleRegistry(code: string, files: SandboxAddonFile[] = []) {
  const sources = new Map<string, { path: string; source: string }>();
  const cssSources = new Map<string, { path: string; source: string }>();
  const mainFile = files.find((file) => file.isMain) ?? files.find((file) => file.content === code);
  const mainPath = normalizeModulePath(mainFile?.name ?? "addon.js");
  const moduleBasenameCounts = new Map<string, number>();
  const cssBasenameCounts = new Map<string, number>();

  for (const file of files) {
    const path = normalizeModulePath(file.name);
    if (isCssFile(path)) {
      const basename = getModuleBasename(path);
      cssBasenameCounts.set(basename, (cssBasenameCounts.get(basename) ?? 0) + 1);
      continue;
    }
    if (path.endsWith(".js")) {
      const basename = getModuleBasename(path);
      moduleBasenameCounts.set(basename, (moduleBasenameCounts.get(basename) ?? 0) + 1);
    }
  }

  for (const file of files) {
    const path = normalizeModulePath(file.name);
    if (isCssFile(path)) {
      cssSources.set(path, { path, source: file.content });
      const basename = getModuleBasename(path);
      if (cssBasenameCounts.get(basename) === 1) {
        cssSources.set(basename, { path, source: file.content });
      }
      continue;
    }
    if (!path.endsWith(".js")) {
      continue;
    }
    const source = stripSourceMapReferences(file.content);
    sources.set(path, { path, source });
    const basename = getModuleBasename(path);
    if (moduleBasenameCounts.get(basename) === 1) {
      sources.set(basename, { path, source });
    }
  }

  sources.set(mainPath, { path: mainPath, source: stripSourceMapReferences(code) });

  const objectUrls = new Map<string, string>();
  const resolveModuleSpecifier = (importerPath: string, specifier: string) => {
    const hostModuleUrl = createHostDependencyModuleUrl(specifier, objectUrls);
    if (hostModuleUrl) {
      return hostModuleUrl;
    }

    const resolvedPath = resolveModulePath(importerPath, specifier);
    const cssEntry =
      cssSources.get(resolvedPath) ?? cssSources.get(getModuleBasename(resolvedPath));
    if (cssEntry) {
      const cssUrlKey = `css:${cssSources.has(resolvedPath) ? resolvedPath : getModuleBasename(resolvedPath)}`;
      let cssModuleUrl = objectUrls.get(cssUrlKey);
      if (!cssModuleUrl) {
        cssModuleUrl = URL.createObjectURL(
          new Blob([createCssModuleSource(cssEntry.path, cssEntry.source)], {
            type: "text/javascript",
          }),
        );
        objectUrls.set(cssUrlKey, cssModuleUrl);
      }
      return cssModuleUrl;
    }

    const moduleEntry = sources.get(resolvedPath) ?? sources.get(getModuleBasename(resolvedPath));
    if (!moduleEntry) {
      return specifier;
    }

    const urlKey = sources.has(resolvedPath) ? resolvedPath : getModuleBasename(resolvedPath);
    let moduleUrl = objectUrls.get(urlKey);
    if (!moduleUrl) {
      moduleUrl = URL.createObjectURL(
        new Blob(
          [
            rewriteModuleSpecifiers(
              moduleEntry.path,
              moduleEntry.source,
              resolveModuleSpecifier,
              (specifier) => isHostDependencySpecifier(specifier) || specifier.startsWith("."),
            ),
          ],
          {
            type: "text/javascript",
          },
        ),
      );
      objectUrls.set(urlKey, moduleUrl);
    }
    return moduleUrl;
  };

  const importModule = (importerPath: string, specifier: string) => {
    return import(/* @vite-ignore */ resolveModuleSpecifier(importerPath, specifier));
  };

  Object.assign(globalThis, {
    __wealthfolioImport: importModule,
    __wealthfolioInstallAddonStyle: installAddonStyle,
  });

  return {
    mainPath,
    mainUrl: resolveModuleSpecifier(mainPath, mainPath),
    objectUrls,
  };
}

function findAnchor(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLAnchorElement>("a[href]");
}

function toInternalRoute(rawHref: string) {
  if (!rawHref || rawHref.startsWith("#")) {
    return null;
  }

  const currentUrl = new URL(window.location.href);
  const targetUrl = new URL(rawHref, currentUrl);
  if (targetUrl.origin !== currentUrl.origin) {
    return null;
  }

  return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const anchor = findAnchor(event.target);
  if (!anchor || anchor.hasAttribute("download")) {
    return;
  }
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") {
    return;
  }

  const route = toInternalRoute(anchor.getAttribute("href") ?? "");
  if (!route || route.startsWith("/addon-sandbox.html")) {
    return;
  }

  event.preventDefault();
  callHost("api", { method: "navigation.navigate", args: [route] }).catch((error: unknown) =>
    console.error(error),
  );
});

function assertCloneable(value: unknown) {
  if (typeof structuredClone !== "function") {
    return;
  }
  structuredClone(value);
}

function toHostQueryKey(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }

  if (typeof value === "object" && value !== null && "queryKey" in value) {
    return toHostQueryKey((value as { queryKey?: unknown }).queryKey);
  }

  return undefined;
}

function mirrorHostQueryCall(
  method: "query.invalidateQueries" | "query.refetchQueries",
  args: unknown[],
) {
  const queryKey = toHostQueryKey(args[0]);
  if (!queryKey) {
    return;
  }

  callHost("api", { method, args: [queryKey] }).catch((error: unknown) => console.error(error));
}

function getAddonQueryClient() {
  if (!addonQueryClient) {
    addonQueryClient = new QueryClient();
    const client = addonQueryClient as unknown as {
      invalidateQueries: (...args: unknown[]) => Promise<unknown>;
      refetchQueries: (...args: unknown[]) => Promise<unknown>;
    };
    const invalidateQueries = client.invalidateQueries.bind(client);
    const refetchQueries = client.refetchQueries.bind(client);

    client.invalidateQueries = (...args: unknown[]) => {
      mirrorHostQueryCall("query.invalidateQueries", args);
      return invalidateQueries(...args);
    };
    client.refetchQueries = (...args: unknown[]) => {
      mirrorHostQueryCall("query.refetchQueries", args);
      return refetchQueries(...args);
    };
  }

  return addonQueryClient;
}

function createApiProxy(path: string[] = []): unknown {
  return new Proxy(
    function addonApiProxy() {
      return undefined;
    },
    {
      get(_target, key) {
        if (key === "then" || typeof key === "symbol") {
          return undefined;
        }
        return createApiProxy([...path, String(key)]);
      },
      apply(_target, _thisArg, args: unknown[]) {
        const method = path.join(".");
        if (method === "query.getClient") {
          return getAddonQueryClient();
        }
        if (method.startsWith("events.") && typeof args[0] === "function") {
          const callback = args[0] as (payload: unknown) => void;
          return callHost("eventSubscribe", { method }).then((value) => {
            const { subscriptionId } = value as { subscriptionId: string };
            eventCallbacks.set(subscriptionId, callback);
            return () => {
              eventCallbacks.delete(subscriptionId);
              return callHost("eventUnsubscribe", { subscriptionId });
            };
          });
        }
        assertCloneable(args);
        const result = callHost("api", { method, args });
        if (method.startsWith("logger.") || method.startsWith("toast.")) {
          result.catch((error: unknown) => console.error(error));
          return undefined;
        }
        return result;
      },
    },
  );
}

export function RouteRenderCommit({ onRendered }: { onRendered?: () => void }) {
  React.useEffect(() => {
    onRendered?.();
  }, [onRendered]);
  return null;
}

function createReactRouteRenderer(component: unknown): RouteRenderer {
  return ({ root: routeRoot, location, onRendered }) => {
    const Component = component as React.ElementType;
    if (!reactRouteRoot) {
      routeRoot.replaceChildren();
      reactRouteRoot = ReactDOMClient.createRoot(routeRoot);
    }
    const reactRoot = reactRouteRoot;
    return new Promise<void>((resolve) => {
      const handleRendered = () => {
        onRendered?.();
        resolve();
      };
      React.startTransition(() => {
        reactRoot.render(
          React.createElement(
            React.Suspense,
            { fallback: null },
            // The sandbox has no react-router provider, so the component gets
            // the host location as a prop (re-passed on each navigation).
            React.createElement(Component, { location }),
            React.createElement(RouteRenderCommit, { onRendered: handleRendered }),
          ),
        );
      });
    });
  };
}

function unmountReactRouteRoot() {
  if (!reactRouteRoot) {
    return;
  }
  reactRouteRoot.unmount();
  reactRouteRoot = undefined;
}

function stringFromPrimitive(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function iconNameFromUnknown(value: unknown): string | undefined {
  return stringFromPrimitive(value);
}

function normalizeRoute(route: LegacyRouteConfig) {
  const path = stringFromPrimitive(route.path) ?? "";
  const routeId = (stringFromPrimitive(route.id) ?? path) || crypto.randomUUID?.() || "";
  return {
    path,
    routeId,
    title: typeof route.title === "string" ? route.title : undefined,
  };
}

function createContext() {
  return {
    ui: { root },
    sidebar: {
      addItem(cfg: Record<string, unknown>) {
        const id = stringFromPrimitive(cfg?.id) ?? "";
        const item = {
          id,
          label: stringFromPrimitive(cfg?.label) ?? "",
          icon: iconNameFromUnknown(cfg?.icon),
          route: typeof cfg?.route === "string" ? cfg.route : undefined,
          order: typeof cfg?.order === "number" ? cfg.order : undefined,
        };
        callHost("sidebar.addItem", { item }).catch((error: unknown) => {
          reportHostCallError("sidebar.addItem", error);
        });
        return {
          remove() {
            return callHost("sidebar.removeItem", { itemId: item.id });
          },
        };
      },
    },
    router: {
      add(route: LegacyRouteConfig) {
        const normalizedRoute = normalizeRoute(route);
        // `component` is preferred (host manages the single React root); `render`
        // is the legacy imperative escape hatch. When both are set, component wins.
        if (route?.component) {
          routes.set(normalizedRoute.routeId, createReactRouteRenderer(route.component));
        } else if (typeof route?.render === "function") {
          routes.set(normalizedRoute.routeId, async (context) => {
            unmountReactRouteRoot();
            await (route.render as RouteRenderer)(context);
          });
        } else {
          throw new Error("Sandboxed addon routes must provide component or render(context)");
        }
        return callHost("router.add", { route: normalizedRoute }).catch((error: unknown) => {
          routes.delete(normalizedRoute.routeId);
          reportHostCallError("router.add", error);
          throw error;
        });
      },
    },
    onDisable(callback: unknown) {
      if (typeof callback === "function") {
        disableCallbacks.add(callback as () => Promise<void> | void);
      }
    },
    api: createApiProxy(),
  };
}

function resolveEnable(mod: Record<string, unknown>) {
  const defaultExport = mod?.default;
  if (typeof defaultExport === "function") {
    return defaultExport;
  }
  if (
    defaultExport &&
    typeof defaultExport === "object" &&
    typeof (defaultExport as { enable?: unknown }).enable === "function"
  ) {
    return (defaultExport as { enable: unknown }).enable;
  }
  if (typeof mod?.enable === "function") {
    return mod.enable;
  }
  if (typeof mod?.PortfolioTrackerAddon === "function") {
    return mod.PortfolioTrackerAddon;
  }
  return null;
}

async function loadAddon(code: string, files: SandboxAddonFile[] = []) {
  reportLoadPhase("installing addon styles");
  installAddonCssFiles(files);
  reportLoadPhase("creating addon module registry");
  const moduleRegistry = createAddonModuleRegistry(code, files);
  addonModuleUrls = moduleRegistry.objectUrls;
  addonCodeUrl = moduleRegistry.mainUrl;
  reportLoadPhase(`importing addon module ${moduleRegistry.mainPath}`);
  const mod = (await import(/* @vite-ignore */ addonCodeUrl)) as Record<string, unknown>;
  reportLoadPhase("addon module imported");
  const enable = resolveEnable(mod);
  if (!enable) {
    throw new Error("Addon does not export an enable(context) function");
  }
  reportLoadPhase("running addon enable");
  const result = await (enable as (context: unknown) => unknown)(createContext());
  reportLoadPhase("addon enable resolved");
  addonDisable =
    result &&
    typeof result === "object" &&
    typeof (result as { disable?: unknown }).disable === "function"
      ? (result as { disable: () => Promise<void> | void }).disable
      : undefined;
}

async function renderRoute(routeId: string, location: RouteLocation) {
  const route = routes.get(routeId);
  if (!route) {
    unmountReactRouteRoot();
    root.textContent = "Addon route is not available.";
    throw new Error(`Addon route '${routeId}' is not available`);
  }

  let didRender = false;
  const markRendered = () => {
    didRender = true;
  };
  await route({ root, location, onRendered: markRendered });
  if (!didRender) {
    await waitForNextPaint();
  }
}

async function disableAddon() {
  for (const callback of Array.from(disableCallbacks).reverse()) {
    await callback();
  }
  disableCallbacks.clear();
  if (addonDisable) {
    await addonDisable();
    addonDisable = undefined;
  }
  unmountReactRouteRoot();
  routes.clear();
  eventCallbacks.clear();
  addonQueryClient?.clear();
  addonQueryClient = undefined;
  const mainModuleUrl = addonCodeUrl;
  if (addonCodeUrl) {
    URL.revokeObjectURL(addonCodeUrl);
    addonCodeUrl = undefined;
  }
  for (const moduleUrl of addonModuleUrls.values()) {
    if (moduleUrl !== mainModuleUrl) {
      URL.revokeObjectURL(moduleUrl);
    }
  }
  addonModuleUrls.clear();
  clearAddonStyles();
  root.replaceChildren();
}

window.addEventListener("error", (event) => {
  post("runtimeError", { error: event.message || String(event.error) });
});

window.addEventListener("unhandledrejection", (event) => {
  post("runtimeError", { error: String(event.reason) });
});

window.addEventListener("message", (event: MessageEvent<SandboxMessage>) => {
  const message = event.data;
  if (message?.channel !== CHANNEL || message.addonId !== ADDON_ID || message.nonce !== NONCE) {
    return;
  }

  if (message.type === "rpcResponse") {
    const callbacks = pending.get(message.requestId ?? "");
    if (!callbacks) {
      return;
    }
    pending.delete(message.requestId ?? "");
    if (message.ok) {
      callbacks.resolve(message.result);
    } else {
      callbacks.reject(new Error(message.error || "Addon host call failed"));
    }
    return;
  }

  if (message.type === "event") {
    const callback = eventCallbacks.get(message.subscriptionId ?? "");
    if (callback) {
      callback(message.payload);
    }
    return;
  }

  if (message.type === "themeUpdate") {
    applyHostTheme(message.theme);
    return;
  }

  void (async () => {
    try {
      if (message.type === "disable") {
        try {
          await disableAddon();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          post("runtimeError", { error: errorMessage });
        } finally {
          post("disabled");
        }
      } else if (message.type === "loadAddon" && typeof message.code === "string") {
        applyHostTheme(message.theme);
        await loadAddon(message.code, message.files);
        post("loaded");
      } else if (message.type === "renderRoute" && message.routeId && message.location) {
        await renderRoute(message.routeId, message.location);
        post("routeRendered", { requestId: message.requestId });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (message.type === "renderRoute") {
        post("routeRenderError", {
          error: errorMessage,
          requestId: message.requestId,
        });
      } else {
        post("loadError", {
          error: errorMessage,
        });
      }
    }
  })();
});

post("ready");
