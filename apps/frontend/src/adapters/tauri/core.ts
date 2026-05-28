// Core utilities for Tauri adapter - internal use only
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

import type { Logger } from "../types";

/**
 * Logger implementation using Tauri's log plugin
 * Wraps the Tauri log functions to match the Logger interface
 */
export const logger: Logger = {
  error: (...args: unknown[]) => {
    error(args.map(String).join(" "));
  },
  warn: (...args: unknown[]) => {
    warn(args.map(String).join(" "));
  },
  info: (...args: unknown[]) => {
    info(args.map(String).join(" "));
  },
  debug: (...args: unknown[]) => {
    debug(args.map(String).join(" "));
  },
  trace: (...args: unknown[]) => {
    trace(args.map(String).join(" "));
  },
};

// 5 min matches the web adapter and server request timeout. Heavy retirement
// commands can legitimately exceed 2 min on slower machines.
const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

// Commands that legitimately do batched network I/O over many symbols can need
// more than the default cap. Larger imports, especially Options, can exceed 5 min.
const INVOKE_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  preview_import_assets: 600_000,
  check_activities_import: 600_000,
};

/**
 * Invoke a Tauri command (internal - use typed adapter functions instead)
 */
export const invoke = async <T>(command: string, payload?: Record<string, unknown>): Promise<T> => {
  const timeoutMs = INVOKE_TIMEOUT_OVERRIDES_MS[command] ?? DEFAULT_INVOKE_TIMEOUT_MS;
  try {
    const result = await Promise.race([
      tauriInvoke<T>(command, payload),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Command "${command}" timed out`)), timeoutMs),
      ),
    ]);
    return result;
  } catch (err) {
    const payloadKeys = payload ? Object.keys(payload).sort().join(", ") : "none";
    logger.error(`[Invoke] Command "${command}" failed (payload keys: ${payloadKeys}): ${err}`);
    throw err;
  }
};

// Re-export tauriInvoke for cases where we need direct access (e.g., Channel streaming)
export { tauriInvoke };

// Platform detection flags for shared modules
export const isDesktop = true;
export const isWeb = false;
