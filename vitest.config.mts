import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
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
      // Ratchet floors ~1.5 points under the measured baseline (2026-10-11,
      // Vitest 4 AST-based v8 remapping: lines 82.16, statements 79.10,
      // branches 72.57, functions 85.18). Raise, never lower.
      thresholds: {
        lines: 80.5,
        statements: 77.5,
        branches: 71,
        functions: 83.5,
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
