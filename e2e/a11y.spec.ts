import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createRoom, rollableDice, startGame } from "./support/ludo";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
}

test("home and offline screens have no serious axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Private Room/ })).toBeVisible();
  expect(await seriousViolations(page), "home").toEqual([]);

  await page.goto("/offline");
  await page.getByRole("button", { name: "Start local game" }).waitFor();
  expect(await seriousViolations(page), "offline setup").toEqual([]);

  await page.getByRole("button", { name: "Start local game" }).click();
  await expect(rollableDice(page)).toBeVisible();
  expect(await seriousViolations(page), "offline game").toEqual([]);
});

test("online lobby and game have no serious axe violations", async ({ page }) => {
  await createRoom(page, "Asha");
  await page.getByRole("button", { name: "Add computer" }).last().click();
  await expect(page.getByText("· computer")).toBeVisible();
  expect(await seriousViolations(page), "lobby").toEqual([]);

  await startGame(page, 2);
  await expect(page.getByLabel("Ludo board")).toBeVisible();
  expect(await seriousViolations(page), "game").toEqual([]);
});
