import { expect, test } from "@playwright/test";
import { movableTokens, rollableDice, tabTo } from "./support/ludo";

test("a pass-and-play turn can be played with the keyboard alone", async ({
  page,
}) => {
  // Every roll is a 6, so the first roll always offers a choice of tokens.
  await page.addInitScript(() => {
    Math.random = () => 0.999;
  });
  await page.goto("/offline");
  await expect(page.getByRole("button", { name: "Start local game" })).toBeVisible();

  await tabTo(page, /^Start local game$/);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Offline · LOCAL")).toBeVisible();

  await tabTo(page, /^Roll dice$/);
  await page.keyboard.press("Enter");
  await expect(movableTokens(page)).toHaveCount(4);

  await tabTo(page, /^Move \w+ token 1$/);
  const focused = page.locator(":focus");
  await expect(focused).toHaveAccessibleName(/^Move \w+ token 1$/);
  // A visible focus ring, not just programmatic focus.
  await expect(focused).toHaveCSS("stroke-width", "6px");
  await page.keyboard.press("Enter");

  // Leaving the yard on a 6 earns another roll.
  await expect(movableTokens(page)).toHaveCount(0);
  await expect(rollableDice(page)).toBeVisible();
});
