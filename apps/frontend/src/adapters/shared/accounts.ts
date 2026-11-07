// Account Commands
import type { Account } from "@/lib/types";
import type { newAccountSchema } from "@/lib/schemas";
import type z from "zod";

import { invoke, logger, isTauri } from "./platform";

export interface CreditCardStatement {
  startDate: string;
  closingDate: string;
  dueDate: string;
  isClosed: boolean;
  balances: { currency: string; balance: string }[];
}

export const getCreditCardStatements = (accountId: string): Promise<CreditCardStatement[]> =>
  invoke("get_credit_card_statements", { accountId });

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
    // Platform-aware: desktop strips currency (immutable after creation)
    const payload = isTauri
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
