import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CONVEX_URL = process.env.E2E_CONVEX_URL ?? "http://127.0.0.1:3210";

// Specs create rooms and play real turns; never point them at a shared deployment.
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(CONVEX_URL)) {
  throw new Error(`E2E_CONVEX_URL must be a local Convex backend, got ${CONVEX_URL}`);
}

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // One worker: parallel multi-context specs pushed local `rooms:getRoom`
  // calls past the backend's 1s query limit.
  workers: 1,
  // Retries would hide flakes; the suite is expected to pass on the first try.
  retries: 0,
  forbidOnly: CI,
  reporter: CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // Reduced motion switches the board to SVG tokens. Software-rendered WebGL
    // in several contexts starved the local backend past its 1s query limit.
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Reuses an already running `npx convex dev`; in CI it starts the
      // anonymous local deployment configured by the workflow.
      command: "npx convex dev --tail-logs disable",
      url: `${CONVEX_URL}/version`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !CI,
      timeout: 600_000,
      env: {
        NEXT_PUBLIC_CONVEX_URL: CONVEX_URL,
        NEXT_DIST_DIR: ".next-e2e",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
