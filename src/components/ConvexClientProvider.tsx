"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import { useConvexAuthBridge } from "@/lib/auth";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = useMemo(() => {
    if (!url) return null;
    return new ConvexReactClient(url);
  }, [url]);

  if (!client) {
    return (
      <div
        style={{
          padding: "2rem",
          fontFamily: "var(--font-body), system-ui, sans-serif",
          maxWidth: 420,
          color: "var(--ink, #1e1810)",
        }}
      >
        <h1
          style={{
            fontSize: "1.5rem",
            fontFamily: "var(--font-display), Georgia, serif",
          }}
        >
          Setup needed
        </h1>
        <p>
          <code>NEXT_PUBLIC_CONVEX_URL</code> is not set. Run{" "}
          <code>npx convex dev</code> locally, or add the Convex deployment URL
          to your environment.
        </p>
      </div>
    );
  }

  // Anonymous visitors get no token and keep playing exactly as before.
  return (
    <ConvexProviderWithAuth client={client} useAuth={useConvexAuthBridge}>
      {children}
    </ConvexProviderWithAuth>
  );
}
