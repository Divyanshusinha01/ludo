import { expect, test } from "@playwright/test";
import {
  createRoom,
  joinRoom,
  moveLogText,
  nextRoller,
  startGame,
  takeTurn,
} from "./support/ludo";

test("two browsers join by code and play several turns in sync", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  const code = await createRoom(host, "Host");
  await joinRoom(guest, code, "Guest");
  await expect(host.getByText("Guest", { exact: true })).toBeVisible();

  await startGame(host, 2);

  const rolls = { Host: 0, Guest: 0 };
  for (let i = 0; i < 8; i++) {
    const roller = await nextRoller([host, guest]);
    await takeTurn(roller);
    rolls[roller === host ? "Host" : "Guest"]++;
  }
  expect(rolls.Host).toBeGreaterThan(0);
  expect(rolls.Guest).toBeGreaterThan(0);

  // Both subscriptions converge on the same server-side history.
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([moveLogText(host), moveLogText(guest)]);
      return a.length > 0 && a.join("\n") === b.join("\n");
    })
    .toBe(true);
  const log = await moveLogText(host);
  expect(log.filter((line) => /^(Host|Guest) rolled \d$/.test(line)).length)
    .toBeGreaterThanOrEqual(8);

  await hostContext.close();
  await guestContext.close();
});
