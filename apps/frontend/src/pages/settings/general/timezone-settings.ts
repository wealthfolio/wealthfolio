const TIMEZONE_FALLBACKS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

export function getSupportedTimezones(): string[] {
  const supportedValuesOf = (
    Intl as unknown as {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;

  const rawValues: string[] =
    typeof supportedValuesOf === "function" ? supportedValuesOf("timeZone") : TIMEZONE_FALLBACKS;

  const merged = rawValues.includes("UTC") ? rawValues : ["UTC", ...rawValues];
  return Array.from(new Set(merged)).sort((a, b) => a.localeCompare(b));
}

export function detectBrowserTimezone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  if (!detected) {
    return "UTC";
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: detected }).format(new Date());
    return detected;
  } catch {
    return "UTC";
  }
}

export function resolveInitialTimezone(configuredTimezone: string | null | undefined): string {
  const configured = configuredTimezone?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }

  return "";
}
