import { expect, test } from "@playwright/test";
import {
  createRoom,
  moveLog,
  moveLogText,
  rollableDice,
  startGame,
  takeTurn,
} from "./support/ludo";

test("guest creates a room, adds a computer, rolls and moves a token", async ({
  page,
}) => {
  await createRoom(page, "Asha");

  await page.getByRole("button", { name: "Add computer" }).last().click();
  await expect(page.getByText("· computer")).toBeVisible();
  await startGame(page, 2);

  // Tokens only leave the yard on a 6, so keep taking turns until a roll
  // offers a choice. P(no 6 in 30 of our turns) is below 1 in 10^4.
  let moved = false;
  for (let turn = 0; turn < 30 && !moved; turn++) {
    await expect(rollableDice(page)).toBeVisible({ timeout: 30_000 });
    const outcome = await takeTurn(page, async (token) => {
      // Real pointer path: the board resolves taps geometrically on the SVG.
      const box = (await token.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    moved = outcome === "moved";
  }
  expect(moved, "a roll should have offered a token to move").toBe(true);

  // The move was a 6 out of the yard, which earns another roll.
  await expect(rollableDice(page)).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);

  expect(await moveLogText(page)).toContain("Asha rolled 6");

  // Keep playing until the computer has taken a turn of its own.
  const computerRolls = moveLog(page).filter({ hasText: /^Computer rolled \d$/ });
  for (let turn = 0; turn < 10 && (await computerRolls.count()) === 0; turn++) {
    await expect(rollableDice(page).or(computerRolls).first()).toBeVisible({
      timeout: 30_000,
    });
    if (await rollableDice(page).isVisible()) await takeTurn(page);
  }
  await expect(computerRolls.first()).toBeVisible({ timeout: 30_000 });
});
