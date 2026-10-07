// Core utilities for Tauri adapter - internal use only
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

import { profileScope, revokeProfileSession } from "@/features/profiles/session";
import type { Logger } from "../types";
import { invokeTimeoutMs } from "../invoke-timeout";

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

/**
 * Invoke a Tauri command (internal - use typed adapter functions instead)
 */
export const invoke = async <T>(command: string, payload?: Record<string, unknown>): Promise<T> => {
  const timeoutMs = invokeTimeoutMs(command);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      tauriInvoke<T>(command, payload),
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(
            () => reject(new Error(`Command "${command}" timed out`)),
            timeoutMs,
          )),
      ),
    ]);
    return result;
  } catch (err) {
    logger.error(`[Invoke] Command "${command}" failed: ${err}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

// Re-export tauriInvoke for cases where we need direct access (e.g., Channel streaming)
export async function tauriInvoke<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  // These commands operate only on the application shell, never portfolio data.
  if (
    ["open_external_url", "check_for_updates", "install_app_update", "get_platform"].includes(
      command,
    )
  )
    return rawInvoke<T>(command, payload);
  try {
    const result = await rawInvoke<T>(command, { ...payload, scopeId: profileScope() });
    profileScope(); // discard a response delivered after local revocation
    return result;
  } catch (error) {
    if (/PROFILE_(LOCKED|STALE)/.test(String(error))) revokeProfileSession();
    throw error;
  }
}

// Platform detection flags for shared modules
export const isDesktop = true;
export const isWeb = false;
