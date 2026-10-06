// Tauri adapter - Web Push notifications are a self-hosted server feature.
// Desktop apps are local-first with no server to push from, so these reject.
import type { NotificationSendReport, WebPushSubscriptionInput } from "../types";

const unavailable = () =>
  new Error("Push notifications are available on the self-hosted web server only");

export const getWebPushPublicKey = (): Promise<string> => Promise.reject(unavailable());

export const subscribeWebPush = (_subscription: WebPushSubscriptionInput): Promise<void> =>
  Promise.reject(unavailable());

export const unsubscribeWebPush = (_endpoint: string): Promise<void> =>
  Promise.reject(unavailable());

export const sendTestNotification = (
  _title: string,
  _body: string,
): Promise<NotificationSendReport> => Promise.reject(unavailable());
