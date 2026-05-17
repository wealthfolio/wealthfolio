// Account Commands
import type { Account } from "@/lib/types";
import type { newAccountSchema } from "@/lib/schemas";
import type z from "zod";

import { invoke, logger, isDesktop } from "./platform";

type NewAccount = z.infer<typeof newAccountSchema>;

export const getAccounts = async (includeArchived?: boolean): Promise<Account[]> => {
  try {
    return await invoke<Account[]>("get_accounts", { includeArchived: includeArchived ?? false });
  } catch (error) {
    logger.error("Error fetching accounts.");
    throw error;
  }
};

export const createAccount = async (account: NewAccount): Promise<Account> => {
  try {
    return await invoke<Account>("create_account", { account });
  } catch (error) {
    logger.error("Error creating account.");
    throw error;
  }
};

export const updateAccount = async (account: NewAccount): Promise<Account> => {
  try {
    // Platform-aware: desktop strips currency (immutable after creation).
    // `taxTreatment` is Option-typed on the backend; when the caller omits it,
    // JSON.stringify drops the undefined key and the repository preserves
    // the existing value.
    const payload = isDesktop
      ? (() => {
          const { currency: _, ...rest } = account;
          return rest;
        })()
      : account;
    return await invoke<Account>("update_account", { accountUpdate: payload });
  } catch (error) {
    logger.error("Error updating account.");
    throw error;
  }
};

export const deleteAccount = async (accountId: string): Promise<void> => {
  try {
    await invoke<void>("delete_account", { accountId });
  } catch (error) {
    logger.error("Error deleting account.");
    throw error;
  }
};
