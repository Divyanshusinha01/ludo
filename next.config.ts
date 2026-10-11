import type { NextConfig } from "next";

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
};

export default nextConfig;
