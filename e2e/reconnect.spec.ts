import { expect, test } from "@playwright/test";
import {
  createRoom,
  joinRoom,
  moveLogText,
  nextRoller,
  startGame,
  takeTurn,
} from "./support/ludo";

test("a player who drops offline catches up without refreshing", async ({
  browser,
}) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  const code = await createRoom(host, "Host");
  await joinRoom(guest, code, "Guest");
  await startGame(host, 2);

  const roller = await nextRoller([host, guest]);
  const dropped = roller === host ? guest : host;
  const droppedContext = roller === host ? guestContext : hostContext;
  const rollerName = roller === host ? "Host" : "Guest";

  // A full reload would wipe this marker.
  await dropped.evaluate(() => {
    (window as Window & { __e2eNoReload?: boolean }).__e2eNoReload = true;
  });
  const before = (await moveLogText(dropped)).length;

  await droppedContext.setOffline(true);
  await expect(
    dropped.getByRole("heading", { name: "Reconnecting…" }),
  ).toBeVisible();

  // The game keeps going while the other seat is away.
  await takeTurn(roller);
  const rollerLog = await moveLogText(roller);
  expect(rollerLog.length).toBeGreaterThan(before);
  expect(rollerLog.some((line) => line.startsWith(`${rollerName} rolled`))).toBe(true);

  await droppedContext.setOffline(false);

  await expect(dropped.getByRole("heading", { name: "Reconnecting…" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([moveLogText(roller), moveLogText(dropped)]);
      return a.join("\n") === b.join("\n");
    })
    .toBe(true);
  expect(
    await dropped.evaluate(
      () => (window as Window & { __e2eNoReload?: boolean }).__e2eNoReload,
    ),
  ).toBe(true);

  // The reconnected seat can act again once the die comes round.
  let droppedRolled = false;
  for (let i = 0; i < 10 && !droppedRolled; i++) {
    const next = await nextRoller([host, guest]);
    await takeTurn(next);
    droppedRolled = next === dropped;
  }
  expect(droppedRolled).toBe(true);

  await hostContext.close();
  await guestContext.close();
});
