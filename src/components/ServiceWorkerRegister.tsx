"use client";

import { useEffect } from "react";

function precachePaths(registration: ServiceWorkerRegistration, paths: string[]) {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return;
  for (const path of paths) {
    worker.postMessage({ type: "PRECACHE_PATH", path });
  }
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        const paths = ["/offline", "/"];
        precachePaths(registration, paths);

        registration.addEventListener("updatefound", () => {
          const next = registration.installing;
          if (!next) return;
          next.addEventListener("statechange", () => {
            if (next.state === "activated") {
              precachePaths(registration, paths);
            }
          });
        });

        return navigator.serviceWorker.ready;
      })
      .then((registration) => {
        if (navigator.onLine) {
          precachePaths(registration, ["/offline", "/"]);
        }
      })
      .catch(() => {
        /* unsupported or blocked */
      });
  }, []);

  return null;
}
