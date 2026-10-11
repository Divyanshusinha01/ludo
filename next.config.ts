import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

function convexOrigins(): string[] {
  const origins = ["https://*.convex.cloud", "wss://*.convex.cloud", "https://*.convex.site"];
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (url) {
    try {
      const { protocol, host } = new URL(url);
      origins.push(`${protocol}//${host}`, `${protocol === "https:" ? "wss:" : "ws:"}//${host}`);
    } catch {
      // A malformed URL fails at runtime in the Convex client, not here.
    }
  }
  return [...new Set(origins)];
}

// Report-only until it has been watched in production: violations are logged
// to the browser console instead of breaking Convex sync, WebRTC or WebGL.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${convexOrigins().join(" ")}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // E2E builds bake in a local Convex URL, so they must not overwrite .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    optimizePackageImports: [
      "@react-three/fiber",
      "@react-three/drei",
      "three",
      "convex/react",
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
