// Web Push service worker for the self-hosted web server.
//
// Registered only when a user enables notifications. It handles push and
// notification-click events and nothing else: there is no fetch handler, so it
// never intercepts requests or caches the app.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Wealthfolio";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url: safePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          // navigate() rejects for a window this worker does not control
          // (one opened before it was registered); focusing it is enough then.
          return client
            .focus()
            .then((focused) => (focused.navigate ? focused.navigate(target).catch(() => focused) : focused));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// Same-origin paths only, matching the server's validation: a notification
// must never be a way to send someone to another site.
function safePath(url) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\")) {
    return "/";
  }
  return url;
}
