const CACHE_NAME = "easy-billing-v27";
const ASSETS = [
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./firebase-config.js",
  "./js/vendor/jspdf.umd.min.js",
  "./js/app.js",
  "./js/app-version.js",
  "./js/auth-guard.js",
  "./js/auth.js",
  "./js/customers.js",
  "./js/invoices.js",
  "./js/payments.js",
  "./js/pagination.js",
  "./js/quick-orders.js",
  "./js/dashboard.js",
  "./js/dashboard-analytics.js",
  "./js/reports.js",
  "./js/reports-analytics.js",
  "./js/invoice-form.js",
  "./js/invoice-pdf.js",
  "./js/loading.js",
  "./js/toast.js",
  "./js/number-to-words-in.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

function isLocalDevHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Local dev: do not pretend the app works when START.bat / server is stopped.
  // Cache-first made the UI look "online" after STOP.bat; Firebase still worked (Google), which was confusing.
  if (isLocalDevHost(url.hostname)) {
    const isPageNavigation =
      request.mode === "navigate" || request.destination === "document";

    if (isPageNavigation) {
      event.respondWith(
        fetch(request)
          .then((res) => {
            if (res.ok && res.type === "basic") {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return res;
          })
          .catch(() => {
            return new Response(
              [
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Server stopped</title></head>",
                "<body style=\"font-family:system-ui;padding:2rem;max-width:36rem\">",
                "<h1>Local server is not running</h1>",
                "<p>Double-click <strong>START.bat</strong> in the Easy Billing folder, then refresh.</p>",
                "<p><small>STOP.bat only stops the small web server on your PC. Sign-in and data use Firebase (internet), not localhost.</small></p>",
                "</body></html>",
              ].join(""),
              { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
          })
      );
      return;
    }

    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        const copy = res.clone();
        if (res.ok && res.type === "basic") {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return res;
      });
    })
  );
});
