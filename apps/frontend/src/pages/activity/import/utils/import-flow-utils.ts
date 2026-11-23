import type { ParseConfig } from "../context";

export function mergeDetectedParseConfig(
  currentConfig: ParseConfig,
  detectedConfig?: Partial<ParseConfig>,
): ParseConfig {
  return {
    ...currentConfig,
    ...(detectedConfig ?? {}),
    // The parser reports the delimiter it used for this file. Keep the requested one so
    // "auto" still detects the delimiter of the next file.
    delimiter: currentConfig.delimiter,
  };
}

export function shouldUseSavedHoldingsMapping(suppressLinkedTemplate: boolean): boolean {
  return !suppressLinkedTemplate;
}
