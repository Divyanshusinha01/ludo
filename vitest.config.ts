import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(__dirname, "./src"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // One line per successful Convex mutation; tests that need it spy on console.log.
    onConsoleLog: (log) => !log.includes('"event":"mutation_ok"'),
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.ts", "tests/game/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["tests/convex/**/*.test.ts"],
          testTimeout: 300_000,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        resolve: { alias },
        esbuild: { jsx: "automatic" },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.tsx"],
          setupFiles: ["tests/ui/setup.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
