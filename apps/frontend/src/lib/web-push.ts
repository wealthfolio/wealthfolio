// Browser side of Web Push on the self-hosted web server: registers the push
// service worker, asks the browser for a subscription signed to the server's
// VAPID key, and hands it to the server. Payloads are encrypted to this
// browser's keys, so the push service relaying them cannot read them.

import { getWebPushPublicKey, subscribeWebPush, unsubscribeWebPush } from "@/adapters";

const SERVICE_WORKER_URL = "/push-sw.js";

export type WebPushStatus =
  /** No Service Worker or Push API, or not a secure context (push needs HTTPS). */
  | "unsupported"
  /** The user blocked notifications; only the browser's site settings can undo it. */
  | "denied"
  | "enabled"
  | "disabled";

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  if (!isWebPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await currentSubscription()) ? "enabled" : "disabled";
}

/** Asks for permission, subscribes this browser, and registers it with the server. */
export async function enableWebPush(): Promise<WebPushStatus> {
  if (!isWebPushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "disabled";

  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await navigator.serviceWorker.ready;
  const publicKey = await getWebPushPublicKey();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  await subscribeWebPush(toSubscriptionInput(subscription));
  return "enabled";
}

/** Removes this browser from the server first, then from the push service. */
export async function disableWebPush(): Promise<WebPushStatus> {
  const subscription = await currentSubscription();
  if (subscription) {
    await unsubscribeWebPush(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return "disabled";
}

export function toSubscriptionInput(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("The browser returned an incomplete push subscription");
  }
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** `applicationServerKey` wants raw bytes; the server sends base64url. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
