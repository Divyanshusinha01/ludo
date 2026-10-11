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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["convex/lib/**/*.ts", "convex/*.ts", "src/lib/**/*.ts"],
      exclude: ["convex/_generated/**", "**/*.d.ts"],
      // Ratchet floors ~1.5 points under the measured baseline (2026-10-11:
      // lines/statements 83.63, branches 85.05, functions 88.76). Raise, never lower.
      thresholds: {
        lines: 82,
        statements: 82,
        branches: 83.5,
        functions: 87,
      },
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.ts", "tests/game/**/*.test.ts", "tests/api/**/*.test.ts"],
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
