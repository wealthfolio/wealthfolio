import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE_URL } from "./helpers";

// Seeds test preconditions through the web API, so a spec clicks only through
// the flow it tests. Each spec creates its own named records; with no auth in
// E2E, requests need no profile header while the installation has one profile.

export async function api<T = unknown>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(`${BASE_URL}/api/v1${path}`, { method, data });
  const body = await response.text();
  expect(response.ok(), `${method} ${path} failed with ${response.status()}: ${body}`).toBe(true);
  return (body ? JSON.parse(body) : undefined) as T;
}

export interface ApiAccount {
  id: string;
  name: string;
  currency: string;
  accountType: string;
}

export function createAccount(
  page: Page,
  account: {
    name: string;
    currency?: string;
    accountType?: string;
    group?: string | null;
    isActive?: boolean;
  },
): Promise<ApiAccount> {
  return api<ApiAccount>(page, "POST", "/accounts", {
    accountType: "SECURITIES",
    currency: "USD",
    group: null,
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    ...account,
  });
}

export interface ApiActivity {
  id: string;
  accountId: string;
  assetId?: string | null;
}

/** One activity through `POST /activities`; `asset` creates or reuses a manual asset. */
export function createActivity(
  page: Page,
  activity: {
    accountId: string;
    activityType: string;
    activityDate: string;
    currency: string;
    amount?: number;
    quantity?: number;
    unitPrice?: number;
    fee?: number;
    notes?: string;
    asset?: { id: string } | { symbol: string; name?: string; quoteCcy?: string };
  },
): Promise<ApiActivity> {
  const { asset, ...rest } = activity;
  return api<ApiActivity>(page, "POST", "/activities", {
    fee: 0,
    needsReview: false,
    ...rest,
    asset:
      asset && "symbol" in asset
        ? {
            name: asset.name ?? asset.symbol,
            symbol: asset.symbol,
            kind: "INVESTMENT",
            quoteCcy: asset.quoteCcy ?? activity.currency,
            quoteMode: "MANUAL",
          }
        : asset,
  });
}

export function deposit(
  page: Page,
  accountId: string,
  amount: number,
  currency: string,
  activityDate = new Date().toISOString(),
) {
  return createActivity(page, {
    accountId,
    activityType: "DEPOSIT",
    activityDate,
    amount,
    currency,
  });
}

export type Settings = Record<string, unknown>;

/** Applies `changes` and returns the values they replaced, for a `finally` restore. */
export async function updateSettings(page: Page, changes: Settings): Promise<Settings> {
  const current = await api<Settings>(page, "GET", "/settings");
  await api(page, "PUT", "/settings", changes);
  return Object.fromEntries(Object.keys(changes).map((key) => [key, current[key]]));
}

export interface SpendingSettings {
  enabled: boolean;
  accountIds: string[];
  excludedCategoryIds: string[];
}

/** Points Spending at `accountIds` only and returns the settings it replaced. */
export async function useSpendingAccounts(
  page: Page,
  accountIds: string[],
): Promise<SpendingSettings> {
  const previous = await api<SpendingSettings>(page, "GET", "/spending/settings");
  await api(page, "PUT", "/spending/settings", { enabled: true, accountIds });
  return previous;
}

export function restoreSpendingSettings(page: Page, previous: SpendingSettings) {
  const { enabled, accountIds, excludedCategoryIds } = previous;
  return api(page, "PUT", "/spending/settings", { enabled, accountIds, excludedCategoryIds });
}

/**
 * A cash account and a credit card named `<prefix> bank …` and `<prefix> card …`,
 * with Spending pointed at those two alone. Restore `previous` when done.
 */
export async function seedSpendingAccounts(page: Page, prefix: string) {
  const bank = await createAccount(page, {
    name: uniqueName(`${prefix} bank`),
    accountType: "CASH",
  });
  const card = await createAccount(page, {
    name: uniqueName(`${prefix} card`),
    accountType: "CREDIT_CARD",
  });
  const previous = await useSpendingAccounts(page, [bank.id, card.id]);
  return { bank, card, previous };
}

/**
 * Looks up `namespace:key.path` in the app's locale files, falling back to
 * English as the app does. Plain strings only: no interpolation or plurals.
 */
export function translator(language: string) {
  const lookup = (lng: string, key: string) => {
    const [namespace, path] = key.split(":");
    const file = new URL(
      `../apps/frontend/src/i18n/locales/${lng}/${namespace}.json`,
      import.meta.url,
    );
    let value: unknown = JSON.parse(readFileSync(file, "utf8"));
    for (const part of path.split(".")) value = (value as Record<string, unknown>)?.[part];
    return typeof value === "string" ? value : undefined;
  };
  return (key: string) => {
    const text = lookup(language, key) ?? lookup("en", key);
    if (text === undefined) throw new Error(`No translation for ${key}`);
    return text;
  };
}

/** A name unique to this run, for records a rerun would otherwise collide with. */
export function uniqueName(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}`;
}
