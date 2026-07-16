// Secrets Commands
import { invoke } from "./platform";

export const setSecret = async (secretKey: string, secret: string): Promise<void> => {
  return invoke<void>("set_secret", { secretKey, secret });
};

export const getSecret = async (secretKey: string): Promise<string | null> => {
  return invoke<string | null>("get_secret", { secretKey });
};

export const deleteSecret = async (secretKey: string): Promise<void> => {
  return invoke<void>("delete_secret", { secretKey });
};

export const setAddonSecret = async (
  addonId: string,
  key: string,
  secret: string,
): Promise<void> => {
  return invoke<void>("set_addon_secret", { addonId, key, secret });
};

export const getAddonSecret = async (addonId: string, key: string): Promise<string | null> => {
  return invoke<string | null>("get_addon_secret", { addonId, key });
};

export const deleteAddonSecret = async (addonId: string, key: string): Promise<void> => {
  return invoke<void>("delete_addon_secret", { addonId, key });
};
