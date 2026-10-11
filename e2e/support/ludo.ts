import { expect, type Locator, type Page } from "@playwright/test";

/** The die only carries one of these names while it is this player's roll. */
export function rollableDice(page: Page): Locator {
  return page.getByRole("button", {
    name: /^(Roll dice|Dice showing \d\. Tap to roll)$/,
  });
}

/** Board targets added for keyboard users; present only while a move is pending. */
export function movableTokens(page: Page): Locator {
  return page.getByRole("button", { name: /^Move \w+ token \d$/ });
}

/** Dice label once the roll is over and another seat is up. */
function waitingDice(page: Page): Locator {
  return page.getByRole("button", { name: /^(Waiting for |Pass device to )|is away$/ });
}

export function moveLog(page: Page): Locator {
  return page.getByLabel("Move history").getByRole("listitem");
}

export async function openPrivateRoomMenu(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^Private Room/ }).click();
}

/** Creates a 1v1 private room as a guest and returns its 6-character code. */
export async function createRoom(page: Page, name: string): Promise<string> {
  await openPrivateRoomMenu(page);
  await page.getByRole("button", { name: "Create Game", exact: true }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create game", exact: true }).click();
  await page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  const code = page.url().match(/\/room\/([A-Z0-9]{6})/)![1]!;
  await expect(page.getByRole("heading", { level: 1, name: code })).toBeVisible();
  return code;
}

export async function joinRoom(page: Page, code: string, name: string) {
  await openPrivateRoomMenu(page);
  await page.getByRole("button", { name: "Join Game", exact: true }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Room code").fill(code);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.getByText(`Waiting for host to start`)).toBeVisible();
}

export async function startGame(host: Page, players: number) {
  await host
    .getByRole("button", { name: `Start game (${players} players)` })
    .click();
  await expect(rollableDice(host).or(waitingDice(host))).toBeVisible();
}

export type TurnOutcome = "moved" | "rolled";

/**
 * Rolls once. If the roll leaves a choice, picks the first legal token with
 * the keyboard (or `choose`). Resolves once the roll has fully played out:
 * a token choice was made, or the die is rollable again, or another seat is up.
 */
export async function takeTurn(
  page: Page,
  choose: (token: Locator) => Promise<void> = (token) => token.press("Enter"),
): Promise<TurnOutcome> {
  const rolls = moveLog(page).filter({ hasText: / rolled \d/ });
  const before = await rolls.count();
  await rollableDice(page).click();
  // The mutation reply can land before the subscription that ends the turn;
  // until the roll shows in this page's log, the die may still look rollable.
  await expect(rolls).toHaveCount(before + 1, { timeout: 20_000 });
  const token = movableTokens(page).first();
  await expect(token.or(rollableDice(page)).or(waitingDice(page))).toBeVisible({
    timeout: 20_000,
  });
  if (!(await token.isVisible())) return "rolled";
  await choose(token);
  await expect(movableTokens(page)).toHaveCount(0);
  await expect(rollableDice(page).or(waitingDice(page))).toBeVisible({
    timeout: 20_000,
  });
  return "moved";
}

/** Waits until one of `pages` holds the die and returns it. */
export async function nextRoller(pages: Page[], timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of pages) {
      if (await rollableDice(page).isVisible()) return page;
    }
    await pages[0]!.waitForTimeout(150);
  }
  throw new Error("No player could roll within the timeout");
}

/** Text of every entry in the move log, oldest first. */
export async function moveLogText(page: Page): Promise<string[]> {
  return moveLog(page).allInnerTexts();
}

/** Presses Tab until the focused element's accessible label matches `name`. */
export async function tabTo(page: Page, name: RegExp, maxPresses = 60) {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "";
      return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    });
    if (name.test(label)) return;
  }
  throw new Error(`Tab never reached an element named ${name}`);
}
