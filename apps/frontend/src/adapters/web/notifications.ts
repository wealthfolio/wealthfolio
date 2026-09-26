// Web adapter - Web Push notifications (self-hosted server)
import type { NotificationSendReport, WebPushSubscriptionInput } from "../types";
import { invoke, logger } from "./core";

export const getWebPushPublicKey = async (): Promise<string> => {
  try {
    const { publicKey } = await invoke<{ publicKey: string }>("get_web_push_public_key");
    return publicKey;
  } catch (error) {
    logger.error("Error fetching the web push public key.");
    throw error;
  }
};

export const subscribeWebPush = async (subscription: WebPushSubscriptionInput): Promise<void> => {
  try {
    await invoke<void>("subscribe_web_push", subscription as unknown as Record<string, unknown>);
  } catch (error) {
    logger.error("Error registering this device for notifications.");
    throw error;
  }
};

export const unsubscribeWebPush = async (endpoint: string): Promise<void> => {
  try {
    await invoke<void>("unsubscribe_web_push", { endpoint });
  } catch (error) {
    logger.error("Error removing this device from notifications.");
    throw error;
  }
};

export const sendTestNotification = async (
  title: string,
  body: string,
): Promise<NotificationSendReport> => {
  try {
    return await invoke<NotificationSendReport>("send_notification", {
      title,
      body,
      tag: "wealthfolio-test",
    });
  } catch (error) {
    logger.error("Error sending a test notification.");
    throw error;
  }
};
