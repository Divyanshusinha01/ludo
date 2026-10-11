import { expect, test } from "@playwright/test";
import { moveLog, rollableDice } from "./support/ludo";

// Full motion keeps the lazily loaded 3D token layer in play; offline it must
// fall back to SVG tokens when its chunk was never cached.
test.use({ reducedMotion: "no-preference" });

test("service worker serves pass-and-play with the network off", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  // The worker caches /offline first, then every /_next asset its HTML names.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const shell = await caches.match("/offline");
          if (!shell) return false;
          const html = await shell.text();
          const assets = [...html.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map(
            (m) => m[1]!,
          );
          const hits = await Promise.all(assets.map((a) => caches.match(a)));
          return assets.length > 0 && hits.every(Boolean);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  const response = await page.goto("/offline");
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);

  await page.getByRole("button", { name: "Start local game" }).click();
  await expect(page.getByText("Offline · LOCAL")).toBeVisible();

  await rollableDice(page).click();
  await expect(moveLog(page).filter({ hasText: /^Player 1 rolled \d/ })).toHaveCount(1);
});
