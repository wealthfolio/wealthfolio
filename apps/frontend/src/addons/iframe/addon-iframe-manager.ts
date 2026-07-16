import type { AddonManifest, Permission, SidebarItemConfig } from "@wealthfolio/addon-sdk";
import type { AddonFile } from "@/adapters/types";
import {
  clearAddonRegistrations,
  createAddonHostAPI,
  registerAddonNavItem,
  registerAddonRoute,
  removeAddonNavItem,
  removeAddonRoute,
} from "@/addons/addons-runtime-context";
import { logger } from "@/adapters";
import { toast } from "sonner";
import { collectAddonThemeSnapshot, type AddonThemeSnapshot } from "./addon-sandbox-theme";
import { createPermissionGuard, type PermissionGuard } from "../type-bridge";

const CHANNEL = "wealthfolio:addon-sandbox:v1";
const LOAD_TIMEOUT_MS = 10_000;
const ROUTE_RENDER_TIMEOUT_MS = 10_000;
const DISABLE_TIMEOUT_MS = 1_000;

interface StartAddonInput {
  addonId: string;
  manifest: AddonManifest;
  code: string;
  files?: AddonFile[];
  permissions?: Permission[];
  /** False when a reload superseded the caller while start-up was awaiting. */
  isCurrent?: () => boolean;
}

export interface AddonRouteLocation {
  pathname: string;
  search: string;
  hash: string;
  params: Record<string, string | undefined>;
}

export type AddonRouteRenderStatus =
  | { status: "idle"; routeKey?: string }
  | { status: "rendering"; cold: boolean; routeKey: string }
  | { status: "rendered"; routeKey: string }
  | { status: "error"; error: string; routeKey?: string };

type AddonRouteStatusListener = (status: AddonRouteRenderStatus) => void;

export interface AddonRuntimeHandle {
  disable(): Promise<void>;
}

interface Runtime {
  addonId: string;
  nonce: string;
  iframe: HTMLIFrameElement;
  code: string;
  files: AddonFile[];
  api: unknown;
  activeContainer?: HTMLElement;
  containerResizeObserver?: ResizeObserver;
  activeRoute?: {
    location: AddonRouteLocation;
    routeId: string;
  };
  isLoaded: boolean;
  loadPhase: string;
  lastRenderedRouteKey?: string;
  permissionGuard: PermissionGuard;
  activeRouteRequestId?: string;
  routeRenderTimer?: number;
  routeRenderTimeout?: number;
  routeStatusListeners: Set<AddonRouteStatusListener>;
  subscriptions: Map<string, () => Promise<void> | void>;
  disableAck?: () => void;
  stopPromise?: Promise<void>;
  resolveLoad: (handle: AddonRuntimeHandle) => void;
  rejectLoad: (error: Error) => void;
  loadTimer: number;
}

interface SandboxMessage {
  channel?: string;
  addonId?: string;
  nonce?: string;
  type?: string;
  requestId?: string;
  method?: string;
  args?: unknown[];
  item?: SidebarItemConfig;
  itemId?: string;
  route?: {
    path?: string;
    routeId?: string;
    title?: string;
  };
  routeId?: string;
  subscriptionId?: string;
  error?: string;
  phase?: string;
}

function createNonce() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36)}`;
}

function createAddonLoadCancelledError(addonId: string, reason = "was unloaded before it loaded") {
  const error = new Error(`Addon '${addonId}' ${reason}`);
  error.name = "AddonLoadCancelled";
  return error;
}

function createSandboxUrl(addonId: string, nonce: string, theme: AddonThemeSnapshot) {
  const basePath = import.meta.env.BASE_URL || "/";
  const sandboxUrl = new URL(
    `${basePath.replace(/\/?$/, "/")}addon-sandbox.html`,
    window.location.href,
  );
  const params = new URLSearchParams({
    addonId,
    backgroundColor: theme.backgroundColor,
    colorScheme: theme.colorScheme,
    foregroundColor: theme.foregroundColor,
    nonce,
    themeClass: theme.themeClass,
  });
  if (theme.fontClass) {
    params.set("fontClass", theme.fontClass);
  }
  sandboxUrl.hash = params.toString();
  return sandboxUrl.toString();
}

function makeRequestId() {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (typeof error === "symbol") {
    return error.description ?? "Symbol";
  }
  if (typeof error === "function") {
    return error.name || "Function";
  }
  if (error === null || error === undefined) {
    return undefined;
  }
  return JSON.stringify(error) ?? "Unknown error";
}

function createRouteRenderKey(routeId: string, location: AddonRouteLocation) {
  const params = Object.entries(location.params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? "")}`)
    .join("&");
  return [routeId, location.pathname, location.search, location.hash, params].join("\n");
}

function clearPendingRouteRender(runtime: Runtime) {
  if (runtime.routeRenderTimer) {
    clearTimeout(runtime.routeRenderTimer);
    runtime.routeRenderTimer = undefined;
  }
  if (runtime.routeRenderTimeout) {
    clearTimeout(runtime.routeRenderTimeout);
    runtime.routeRenderTimeout = undefined;
  }
}

// Permission denials are otherwise invisible: the sandbox promise rejects and
// most add-ons swallow it, leaving the user with silently missing data. Toast
// each addon+function denial once per session (deduped so retry loops don't
// spam) with an actionable hint.
const notifiedPermissionDenials = new Set<string>();

function notifyPermissionDenialOnce(addonId: string, method: string | undefined, error: unknown) {
  if (!(error instanceof Error) || error.name !== "AddonPermissionDenied") {
    return;
  }
  const key = `${addonId}:${method ?? "unknown"}`;
  if (notifiedPermissionDenials.has(key)) {
    return;
  }
  notifiedPermissionDenials.add(key);
  toast.error("Add-on permission denied", {
    description: `'${addonId}' tried to use '${method ?? "an API"}' without permission. Updating the add-on may fix this.`,
    duration: 15000,
  });
}

// The sandbox reports load/runtime/route-render failures as raw message
// strings. Left as-is they surface as a blank view or a generic "failed to
// load" — a class of bug that historically took hours to trace to its real
// cause (e.g. an addon touching localStorage, which throws in the opaque-origin
// sandbox). Classify the common signatures into an actionable, human-readable
// hint so the failure explains itself.
export function classifyAddonErrorHint(rawMessage: string | undefined): string | undefined {
  if (!rawMessage) {
    return undefined;
  }
  const message = rawMessage.toLowerCase();
  // Opaque-origin Web Storage access. Match storage-specific signals, not a
  // bare "securityerror" — a cross-origin frame/cookie access also throws
  // SecurityError and must not be mislabelled as a storage problem.
  if (
    message.includes("localstorage") ||
    message.includes("sessionstorage") ||
    message.includes("allow-same-origin") ||
    (message.includes("securityerror") && message.includes("storage")) ||
    (message.includes("sandbox") && message.includes("storage")) ||
    // WKWebView (Tauri on macOS) reports opaque-origin storage access as a
    // bare "SecurityError: The operation is insecure." with no storage keyword.
    message.includes("the operation is insecure")
  ) {
    return "This add-on uses browser storage (localStorage/sessionStorage), which is unavailable in the add-on sandbox. Update the add-on to use the storage API.";
  }
  if (message.includes("unknown addon host api method")) {
    return "This add-on called an API this version of Wealthfolio does not provide. Update the add-on, or update Wealthfolio.";
  }
  // A contributed route whose id does not match a route the add-on registers
  // at runtime (contributes.routes[].id must equal router.add({ id })).
  if (message.includes("route") && message.includes("is not available")) {
    return "This add-on could not render this page — a declared route id may not match a route the add-on registers. The add-on may need updating.";
  }
  return undefined;
}

// Enrich a raw sandbox error string with its classified hint (for inline
// display in the route error panel). Returns the original message unchanged
// when no signature matches.
function describeAddonError(rawMessage: string | undefined): string {
  const base = rawMessage || "The add-on view failed to load.";
  const hint = classifyAddonErrorHint(rawMessage);
  return hint ? `${base}\n\n${hint}` : base;
}

// Toast a classified load/runtime error once per addon+signature per session.
const notifiedRuntimeErrors = new Set<string>();

function notifyClassifiedAddonErrorOnce(addonId: string, rawMessage: string | undefined) {
  const hint = classifyAddonErrorHint(rawMessage);
  if (!hint) {
    return;
  }
  const key = `${addonId}:${hint}`;
  if (notifiedRuntimeErrors.has(key)) {
    return;
  }
  notifiedRuntimeErrors.add(key);
  toast.error(`Add-on '${addonId}' error`, {
    description: hint,
    duration: 15000,
  });
}

function getParkingRoot() {
  let root = document.getElementById("addon-sandbox-parking");
  if (!root) {
    root = document.createElement("div");
    root.id = "addon-sandbox-parking";
    Object.assign(root.style, {
      inset: "0",
      overflow: "visible",
      pointerEvents: "none",
      position: "fixed",
      // #root intentionally has no z-index, so this layer paints above normal
      // page content while fixed host navigation and portals (z-40+) remain
      // above the add-on frame.
      zIndex: "1",
    });
    document.body.appendChild(root);
  }
  return root;
}

const ALLOWED_API_METHODS = new Set([
  "accounts.getAll",
  "accounts.create",
  "portfolio.getHoldings",
  "portfolio.getHolding",
  "portfolio.update",
  "portfolio.recalculate",
  "portfolio.getIncomeSummary",
  "portfolio.getHistoricalValuations",
  "portfolio.getLatestValuations",
  "activities.getAll",
  "activities.search",
  "activities.create",
  "activities.update",
  "activities.saveMany",
  "activities.import",
  "activities.checkImport",
  "activities.getImportMapping",
  "activities.saveImportMapping",
  "market.searchTicker",
  "market.syncHistory",
  "market.sync",
  "market.getProviders",
  "market.fetchDividends",
  "assets.getProfile",
  "assets.updateProfile",
  "assets.updateQuoteMode",
  "quotes.update",
  "quotes.getHistory",
  "performance.calculateHistory",
  "performance.calculateSummary",
  "performance.calculateAccountsSimple",
  "exchangeRates.getAll",
  "exchangeRates.update",
  "exchangeRates.add",
  "contributionLimits.getAll",
  "contributionLimits.create",
  "contributionLimits.update",
  "contributionLimits.calculateDeposits",
  "goals.getAll",
  "goals.create",
  "goals.update",
  "goals.getFunding",
  "goals.saveFunding",
  "goals.getAllocations",
  "goals.updateAllocations",
  "settings.get",
  "settings.update",
  "settings.backupDatabase",
  "files.openCsvDialog",
  "files.openSaveDialog",
  "snapshots.getAll",
  "snapshots.getByDate",
  "snapshots.save",
  "snapshots.checkImport",
  "snapshots.importSnapshots",
  "snapshots.delete",
  "navigation.navigate",
  "query.invalidateQueries",
  "query.refetchQueries",
  "network.request",
  "secrets.set",
  "secrets.get",
  "secrets.delete",
  "storage.get",
  "storage.set",
  "storage.delete",
  "toast.success",
  "toast.error",
  "toast.warning",
  "toast.info",
  "logger.error",
  "logger.info",
  "logger.warn",
  "logger.trace",
  "logger.debug",
]);

const ALLOWED_EVENT_METHODS = new Set([
  "events.import.onDropHover",
  "events.import.onDrop",
  "events.import.onDropCancelled",
  "events.portfolio.onUpdateStart",
  "events.portfolio.onUpdateComplete",
  "events.portfolio.onUpdateError",
  "events.market.onSyncStart",
  "events.market.onSyncComplete",
]);

const FORBIDDEN_METHOD_PARTS = new Set(["__proto__", "constructor", "prototype"]);

function getProperty(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    return undefined;
  }
  return (target as Record<string, unknown>)[key];
}

function getMethod(target: unknown, methodPath: string, allowedMethods: Set<string>) {
  if (!allowedMethods.has(methodPath)) {
    throw new Error(`Unknown addon host API method '${methodPath}'`);
  }

  const parts = methodPath.split(".").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => FORBIDDEN_METHOD_PARTS.has(part))) {
    throw new Error(`Unknown addon host API method '${methodPath}'`);
  }

  let current = target;

  for (const part of parts) {
    current = getProperty(current, part);
  }

  if (typeof current !== "function") {
    throw new Error(`Unknown addon host API method '${methodPath}'`);
  }

  return current as (...args: unknown[]) => unknown;
}

export class AddonIframeManager {
  private runtimes = new Map<string, Runtime>();
  private listening = false;
  private frameLayoutUpdateFrame?: number;
  private layoutListening = false;
  private themeObserver?: MutationObserver;
  private themeUpdateFrame?: number;

  async startAddon(input: StartAddonInput): Promise<AddonRuntimeHandle> {
    if (input.isCurrent?.() === false) {
      throw createAddonLoadCancelledError(input.addonId, "load was superseded by a reload");
    }
    await this.stopAddon(input.addonId);
    if (input.isCurrent?.() === false) {
      throw createAddonLoadCancelledError(input.addonId, "load was superseded by a reload");
    }
    this.ensureListener();
    this.ensureThemeObserver();

    const nonce = createNonce();
    const initialTheme = collectAddonThemeSnapshot();
    const sandboxUrl = createSandboxUrl(input.addonId, nonce, initialTheme);

    const iframe = document.createElement("iframe");
    iframe.title = `${input.manifest.name || input.addonId} add-on sandbox`;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.referrerPolicy = "no-referrer";
    Object.assign(iframe.style, {
      border: "0",
      backgroundColor: "transparent",
      colorScheme: initialTheme.colorScheme,
      display: "block",
      height: "0",
      left: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      visibility: "hidden",
      width: "0",
    });

    const credentiallessFrame = iframe as HTMLIFrameElement & { credentialless?: boolean };
    if ("credentialless" in credentiallessFrame) {
      credentiallessFrame.credentialless = true;
    }

    let runtime!: Runtime;
    const loadPromise = new Promise<AddonRuntimeHandle>((resolve, reject) => {
      runtime = {
        addonId: input.addonId,
        api: createAddonHostAPI(input.addonId, input.permissions),
        code: input.code,
        files: input.files ?? [],
        iframe,
        isLoaded: false,
        loadPhase: "creating sandbox iframe",
        loadTimer: window.setTimeout(() => {
          if (this.runtimes.get(input.addonId) !== runtime) {
            return;
          }
          const phase = runtime.loadPhase;
          reject(new Error(`Timed out loading addon '${input.addonId}' during ${phase}`));
          void this.stopRuntimeIfCurrent(runtime);
        }, LOAD_TIMEOUT_MS),
        nonce,
        permissionGuard: createPermissionGuard(input.addonId, input.permissions),
        rejectLoad: reject,
        resolveLoad: resolve,
        routeStatusListeners: new Set(),
        subscriptions: new Map(),
      };
      this.runtimes.set(input.addonId, runtime);
    });

    getParkingRoot().appendChild(iframe);
    runtime.loadPhase = "loading sandbox document";
    iframe.addEventListener(
      "error",
      () => {
        if (this.runtimes.get(input.addonId) !== runtime) {
          return;
        }
        // Rejecting is enough: the load-error path in addons-core surfaces a
        // user-facing toast, so no extra notification here.
        runtime.rejectLoad(new Error(`Failed to load add-on sandbox for '${input.addonId}'`));
        void this.stopRuntimeIfCurrent(runtime);
      },
      { once: true },
    );
    iframe.src = sandboxUrl;

    try {
      const handle = await loadPromise;
      if (input.isCurrent?.() === false) {
        await this.stopRuntimeIfCurrent(runtime);
        throw createAddonLoadCancelledError(input.addonId, "load was superseded by a reload");
      }
      return handle;
    } finally {
      clearTimeout(runtime.loadTimer);
    }
  }

  /** Whether an addon's iframe runtime has been booted (used by the activation coordinator). */
  hasRuntime(addonId: string): boolean {
    return this.runtimes.has(addonId);
  }

  getRouteStatus(
    addonId: string,
    routeId: string,
    location: AddonRouteLocation,
  ): AddonRouteRenderStatus {
    const runtime = this.runtimes.get(addonId);
    const routeKey = createRouteRenderKey(routeId, location);
    if (!runtime) {
      return { error: `Addon '${addonId}' is not loaded`, routeKey, status: "error" };
    }
    if (runtime.lastRenderedRouteKey === routeKey) {
      return { routeKey, status: "rendered" };
    }
    if (runtime.activeRouteRequestId) {
      return { cold: !runtime.lastRenderedRouteKey, routeKey, status: "rendering" };
    }
    return { routeKey, status: "idle" };
  }

  subscribeRouteStatus(addonId: string, listener: AddonRouteStatusListener) {
    const runtime = this.runtimes.get(addonId);
    if (!runtime) {
      return () => undefined;
    }
    runtime.routeStatusListeners.add(listener);
    return () => {
      runtime.routeStatusListeners.delete(listener);
    };
  }

  retryRoute(addonId: string) {
    const runtime = this.runtimes.get(addonId);
    if (runtime) {
      this.renderActiveRoute(runtime);
    }
  }

  attachRoute(addonId: string, container: HTMLElement) {
    const runtime = this.runtimes.get(addonId);
    if (!runtime) {
      throw new Error(`Addon '${addonId}' is not loaded`);
    }

    runtime.activeContainer = container;
    runtime.iframe.style.visibility = runtime.lastRenderedRouteKey ? "visible" : "hidden";
    this.ensureLayoutListener();
    this.updateFrameBounds(runtime);
    // Window resize/scroll listeners miss container-only changes (e.g. sidebar
    // collapse reflows the page without either event) — observe the container.
    runtime.containerResizeObserver = new ResizeObserver(() => this.updateFrameBounds(runtime));
    runtime.containerResizeObserver.observe(container);
  }

  updateRoute(addonId: string, routeId: string, location: AddonRouteLocation) {
    const runtime = this.runtimes.get(addonId);
    if (!runtime) {
      throw new Error(`Addon '${addonId}' is not loaded`);
    }

    runtime.activeRoute = { routeId, location };
    this.renderActiveRoute(runtime);
  }

  detachRoute(addonId: string, container?: HTMLElement) {
    const runtime = this.runtimes.get(addonId);
    if (!runtime) {
      return;
    }
    if (container && runtime.activeContainer !== container) {
      return;
    }

    runtime.containerResizeObserver?.disconnect();
    runtime.containerResizeObserver = undefined;
    runtime.activeContainer = undefined;
    runtime.activeRouteRequestId = undefined;
    clearPendingRouteRender(runtime);
    this.hideFrame(runtime);
    this.stopLayoutListenerIfIdle();
  }

  async stopAddon(addonId: string) {
    const runtime = this.runtimes.get(addonId);
    if (!runtime) {
      clearAddonRegistrations(addonId);
      return;
    }
    await this.stopRuntimeIfCurrent(runtime);
  }

  async stopAllAddons() {
    await Promise.all(
      Array.from(this.runtimes.values(), (runtime) => this.stopRuntimeIfCurrent(runtime)),
    );
  }

  private async stopRuntimeIfCurrent(runtime: Runtime) {
    if (this.runtimes.get(runtime.addonId) !== runtime) {
      return;
    }
    runtime.stopPromise ??= this.stopRuntime(runtime);
    await runtime.stopPromise;
  }

  private async stopRuntime(runtime: Runtime) {
    clearTimeout(runtime.loadTimer);
    runtime.activeRouteRequestId = undefined;
    clearPendingRouteRender(runtime);
    const cancellation = createAddonLoadCancelledError(runtime.addonId);
    // Marks deliberate cancellation (stop/reload) so load-error reporting can
    // distinguish it from a real failure.
    runtime.rejectLoad(cancellation);

    const disabled = runtime.isLoaded ? this.waitForDisable(runtime) : Promise.resolve(true);
    this.post(runtime, "disable");
    if (!(await disabled)) {
      logger.warn(`Timed out waiting for addon '${runtime.addonId}' to disable`);
    }

    await this.clearSubscriptions(runtime);
    runtime.containerResizeObserver?.disconnect();
    runtime.containerResizeObserver = undefined;
    this.hideFrame(runtime);
    runtime.iframe.remove();
    if (this.runtimes.get(runtime.addonId) === runtime) {
      this.runtimes.delete(runtime.addonId);
      clearAddonRegistrations(runtime.addonId);
    }
    this.stopLayoutListenerIfIdle();
    this.stopThemeObserverIfIdle();
  }

  private waitForDisable(runtime: Runtime) {
    return new Promise<boolean>((resolve) => {
      let ack: () => void = () => undefined;
      const timer = window.setTimeout(() => {
        if (runtime.disableAck === ack) {
          runtime.disableAck = undefined;
        }
        resolve(false);
      }, DISABLE_TIMEOUT_MS);

      ack = () => {
        clearTimeout(timer);
        resolve(true);
      };
      runtime.disableAck = ack;
    });
  }

  private async clearSubscriptions(runtime: Runtime) {
    for (const unsubscribe of runtime.subscriptions.values()) {
      try {
        await unsubscribe();
      } catch (error) {
        logger.warn(`Failed to remove addon event subscription: ${String(error)}`);
      }
    }
    runtime.subscriptions.clear();
  }

  private async resetRuntimeForReload(runtime: Runtime) {
    runtime.isLoaded = false;
    runtime.lastRenderedRouteKey = undefined;
    runtime.activeRouteRequestId = undefined;
    clearPendingRouteRender(runtime);
    runtime.iframe.style.visibility = "hidden";
    await this.clearSubscriptions(runtime);
    clearAddonRegistrations(runtime.addonId);
  }

  private ensureLayoutListener() {
    if (this.layoutListening) {
      return;
    }
    window.addEventListener("resize", this.scheduleFrameLayoutUpdate);
    window.addEventListener("scroll", this.scheduleFrameLayoutUpdate, true);
    this.layoutListening = true;
  }

  private stopLayoutListenerIfIdle() {
    if (Array.from(this.runtimes.values()).some((runtime) => runtime.activeContainer)) {
      return;
    }
    if (!this.layoutListening) {
      return;
    }
    window.removeEventListener("resize", this.scheduleFrameLayoutUpdate);
    window.removeEventListener("scroll", this.scheduleFrameLayoutUpdate, true);
    this.layoutListening = false;
    if (this.frameLayoutUpdateFrame) {
      cancelAnimationFrame(this.frameLayoutUpdateFrame);
      this.frameLayoutUpdateFrame = undefined;
    }
  }

  private scheduleFrameLayoutUpdate = () => {
    if (this.frameLayoutUpdateFrame) {
      return;
    }

    this.frameLayoutUpdateFrame = requestAnimationFrame(() => {
      this.frameLayoutUpdateFrame = undefined;
      for (const runtime of this.runtimes.values()) {
        if (runtime.activeContainer) {
          this.updateFrameBounds(runtime);
        }
      }
    });
  };

  private hideFrame(runtime: Runtime) {
    Object.assign(runtime.iframe.style, {
      height: "0",
      left: "0",
      minHeight: "0",
      pointerEvents: "none",
      top: "0",
      visibility: "hidden",
      width: "0",
    });
  }

  private hideFailedRoute(runtime: Runtime) {
    // A warm render failure otherwise leaves the previously rendered iframe
    // above the host's error panel. Drop the warm-content marker so Retry uses
    // the cold-loading path and keep the frame non-interactive until success.
    runtime.lastRenderedRouteKey = undefined;
    this.hideFrame(runtime);
  }

  private updateFrameBounds(runtime: Runtime) {
    const container = runtime.activeContainer;
    if (!container?.isConnected) {
      this.hideFrame(runtime);
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(rect.width, 0);
    const height = Math.max(rect.height, 0);
    Object.assign(runtime.iframe.style, {
      height: `${height}px`,
      left: `${rect.left}px`,
      minHeight: "0",
      pointerEvents:
        runtime.iframe.style.visibility === "visible" && width > 0 && height > 0 ? "auto" : "none",
      top: `${rect.top}px`,
      width: `${width}px`,
    });
  }

  private ensureListener() {
    if (this.listening) {
      return;
    }
    window.addEventListener("message", this.handleMessage);
    this.listening = true;
  }

  private handleMessage = (event: MessageEvent) => {
    const message = event.data as SandboxMessage;
    if (message?.channel !== CHANNEL || !message.addonId || !message.nonce) {
      return;
    }

    const runtime = this.runtimes.get(message.addonId);
    if (runtime?.nonce !== message.nonce) {
      return;
    }
    if (event.source !== runtime.iframe.contentWindow) {
      return;
    }

    void this.dispatchMessage(runtime, message);
  };

  private async dispatchMessage(runtime: Runtime, message: SandboxMessage) {
    try {
      switch (message.type) {
        case "loadPhase":
          if (message.phase) {
            runtime.loadPhase = message.phase;
          }
          break;
        case "ready":
          runtime.loadPhase = "sandbox ready";
          await this.resetRuntimeForReload(runtime);
          runtime.loadPhase = "host sent addon code";
          this.post(runtime, "loadAddon", {
            code: runtime.code,
            files: runtime.files,
            theme: collectAddonThemeSnapshot(),
          });
          break;
        case "loaded":
          runtime.isLoaded = true;
          runtime.loadPhase = "loaded";
          runtime.resolveLoad({
            disable: () => this.stopRuntimeIfCurrent(runtime),
          });
          this.renderActiveRoute(runtime);
          break;
        case "loadError": {
          // Log unconditionally: on a sandbox reload the load promise has
          // already settled, so rejectLoad is a no-op and this would
          // otherwise be silent.
          logger.error(`Addon '${runtime.addonId}' failed to load: ${message.error || "unknown"}`);
          notifyClassifiedAddonErrorOnce(runtime.addonId, message.error);
          runtime.rejectLoad(
            new Error(message.error || `Failed to load addon '${runtime.addonId}'`),
          );
          await this.stopAddon(runtime.addonId);
          break;
        }
        case "runtimeError":
          logger.error(`Addon '${runtime.addonId}' runtime error: ${message.error || "unknown"}`);
          notifyClassifiedAddonErrorOnce(runtime.addonId, message.error);
          break;
        case "disabled":
          runtime.disableAck?.();
          runtime.disableAck = undefined;
          break;
        case "routeRendered":
          this.handleRouteRendered(runtime, message);
          break;
        case "routeRenderError":
          this.handleRouteRenderError(runtime, message);
          break;
        case "api":
          await this.handleApiCall(runtime, message);
          break;
        case "eventSubscribe":
          await this.handleEventSubscribe(runtime, message);
          break;
        case "eventUnsubscribe":
          await this.handleEventUnsubscribe(runtime, message);
          break;
        case "sidebar.addItem":
          this.handleSidebarAdd(runtime, message);
          break;
        case "sidebar.removeItem":
          this.handleSidebarRemove(runtime, message);
          break;
        case "router.add":
          this.handleRouterAdd(runtime, message);
          break;
        case "router.remove":
          this.handleRouterRemove(runtime, message);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error(
        `Addon '${runtime.addonId}' message '${message.type ?? "unknown"}' failed: ${String(error)}`,
      );
      notifyPermissionDenialOnce(runtime.addonId, message.method, error);
      if (message.requestId) {
        this.respond(runtime, message.requestId, false, undefined, error);
      }
    }
  }

  private async handleApiCall(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.method) {
      return;
    }
    const method = getMethod(runtime.api, message.method, ALLOWED_API_METHODS);
    const result = await method(...(message.args ?? []));
    this.respond(runtime, message.requestId, true, result);
  }

  private async handleEventSubscribe(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.method) {
      return;
    }

    const method = getMethod(runtime.api, message.method, ALLOWED_EVENT_METHODS);
    const subscriptionId = makeRequestId();
    const unlisten = (await method((event: unknown) => {
      this.post(runtime, "event", { subscriptionId, payload: event });
    })) as () => Promise<void> | void;
    runtime.subscriptions.set(subscriptionId, unlisten);
    this.respond(runtime, message.requestId, true, { subscriptionId });
  }

  private async handleEventUnsubscribe(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.subscriptionId) {
      return;
    }
    const unlisten = runtime.subscriptions.get(message.subscriptionId);
    if (unlisten) {
      await unlisten();
      runtime.subscriptions.delete(message.subscriptionId);
    }
    this.respond(runtime, message.requestId, true, undefined);
  }

  private handleSidebarAdd(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.item) {
      return;
    }
    registerAddonNavItem(runtime.addonId, message.item);
    this.respond(runtime, message.requestId, true, undefined);
  }

  private handleSidebarRemove(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.itemId) {
      return;
    }
    removeAddonNavItem(runtime.addonId, message.itemId);
    this.respond(runtime, message.requestId, true, undefined);
  }

  private handleRouterAdd(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.route?.path || !message.route.routeId) {
      return;
    }
    registerAddonRoute(runtime.addonId, {
      path: message.route.path,
      routeId: message.route.routeId,
      title: message.route.title,
    });
    this.respond(runtime, message.requestId, true, undefined);
  }

  private handleRouterRemove(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || !message.routeId) {
      return;
    }
    removeAddonRoute(runtime.addonId, message.routeId);
    this.respond(runtime, message.requestId, true, undefined);
  }

  private handleRouteRendered(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || message.requestId !== runtime.activeRouteRequestId) {
      return;
    }

    const route = runtime.activeRoute;
    const routeKey = route ? createRouteRenderKey(route.routeId, route.location) : undefined;
    runtime.activeRouteRequestId = undefined;
    clearPendingRouteRender(runtime);
    if (routeKey) {
      runtime.lastRenderedRouteKey = routeKey;
      runtime.iframe.style.visibility = "visible";
      this.updateFrameBounds(runtime);
      this.emitRouteStatus(runtime, { routeKey, status: "rendered" });
    }
  }

  private handleRouteRenderError(runtime: Runtime, message: SandboxMessage) {
    if (!message.requestId || message.requestId !== runtime.activeRouteRequestId) {
      return;
    }

    const route = runtime.activeRoute;
    const routeKey = route ? createRouteRenderKey(route.routeId, route.location) : undefined;
    runtime.activeRouteRequestId = undefined;
    clearPendingRouteRender(runtime);
    this.hideFailedRoute(runtime);
    notifyClassifiedAddonErrorOnce(runtime.addonId, message.error);
    this.emitRouteStatus(runtime, {
      error: describeAddonError(
        message.error || `Failed to render add-on route '${route?.routeId ?? "unknown"}'`,
      ),
      routeKey,
      status: "error",
    });
  }

  private emitRouteStatus(runtime: Runtime, status: AddonRouteRenderStatus) {
    for (const listener of runtime.routeStatusListeners) {
      listener(status);
    }
  }

  private respond(
    runtime: Runtime,
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: unknown,
  ) {
    this.post(runtime, "rpcResponse", {
      error: formatUnknownError(error),
      ok,
      requestId,
      result,
    });
  }

  private post(runtime: Runtime, type: string, payload: Record<string, unknown> = {}) {
    runtime.iframe.contentWindow?.postMessage(
      {
        addonId: runtime.addonId,
        channel: CHANNEL,
        nonce: runtime.nonce,
        type,
        ...payload,
      },
      "*",
    );
  }

  private ensureThemeObserver() {
    if (this.themeObserver) {
      return;
    }

    this.themeObserver = new MutationObserver(this.scheduleThemeBroadcast);
    this.themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    this.themeObserver.observe(document.body, {
      attributeFilter: ["class"],
      attributes: true,
    });
  }

  private stopThemeObserverIfIdle() {
    if (this.runtimes.size > 0) {
      return;
    }

    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    if (this.themeUpdateFrame) {
      cancelAnimationFrame(this.themeUpdateFrame);
      this.themeUpdateFrame = undefined;
    }
  }

  private scheduleThemeBroadcast = () => {
    if (this.themeUpdateFrame) {
      return;
    }

    this.themeUpdateFrame = requestAnimationFrame(() => {
      this.themeUpdateFrame = undefined;
      this.broadcastTheme();
    });
  };

  private broadcastTheme() {
    const theme = collectAddonThemeSnapshot();
    for (const runtime of this.runtimes.values()) {
      this.post(runtime, "themeUpdate", { theme });
    }
  }

  private renderActiveRoute(runtime: Runtime) {
    if (!runtime.isLoaded || !runtime.activeContainer || !runtime.activeRoute) {
      return;
    }

    const route = runtime.activeRoute;
    const routeKey = createRouteRenderKey(route.routeId, route.location);
    const requestId = makeRequestId();

    clearPendingRouteRender(runtime);
    runtime.activeRouteRequestId = requestId;
    const hasRenderedContent = Boolean(runtime.lastRenderedRouteKey);
    runtime.iframe.style.visibility = hasRenderedContent ? "visible" : "hidden";
    this.updateFrameBounds(runtime);
    this.emitRouteStatus(runtime, {
      cold: !hasRenderedContent,
      routeKey,
      status: "rendering",
    });

    runtime.routeRenderTimer = window.setTimeout(() => {
      if (
        !runtime.isLoaded ||
        !runtime.activeContainer ||
        runtime.activeRoute !== route ||
        runtime.activeRouteRequestId !== requestId
      ) {
        return;
      }
      this.post(runtime, "renderRoute", { ...route, requestId });
    }, 0);

    runtime.routeRenderTimeout = window.setTimeout(() => {
      if (runtime.activeRouteRequestId !== requestId) {
        return;
      }
      runtime.activeRouteRequestId = undefined;
      clearPendingRouteRender(runtime);
      this.hideFailedRoute(runtime);
      this.emitRouteStatus(runtime, {
        error: `Timed out rendering add-on route '${route.routeId}'`,
        routeKey,
        status: "error",
      });
    }, ROUTE_RENDER_TIMEOUT_MS);
  }
}

export const addonIframeManager = new AddonIframeManager();
