import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { parseMentionedColors } from "../../convex/chat";
import { botClientId } from "../../convex/lib/bot";
import { GameError } from "../../convex/lib/errors";
import type { Color } from "../../convex/lib/ludo";
import {
  CHAT_MIN_INTERVAL_MS,
  MAX_CHAT_LEN,
  MAX_CHAT_MESSAGES,
  sanitizeChatText,
} from "../../convex/lib/session";
import {
  advance,
  clientId,
  setupConvex,
  startedRoom,
  teardownConvex,
  type DiceQueue,
  type RoomId,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
});

const OUTSIDER = clientId(999);

async function send(roomId: RoomId, client: string, text: string) {
  return await t.mutation(api.chat.sendMessage, { roomId, clientId: client, text });
}

async function list(roomId: RoomId, client: string) {
  return await t.query(api.chat.listMessages, { roomId, clientId: client });
}

async function storedMessages(roomId: RoomId) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("chatMessages")
      .withIndex("by_room_createdAt", (q) => q.eq("roomId", roomId))
      .collect(),
  );
}

function fakePlayer(id: string, name: string, color: Color, isBot = false): Doc<"players"> {
  return { _id: id as Id<"players">, name, color, isBot } as Doc<"players">;
}

describe("sanitizeChatText", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeChatText("  hi\u0000\u0007 \t\n there\u007F  ")).toBe("hi there");
  });

  it(`caps messages at ${MAX_CHAT_LEN} characters`, () => {
    expect(sanitizeChatText("x".repeat(MAX_CHAT_LEN + 50))).toHaveLength(MAX_CHAT_LEN);
  });

  it.each(["", "   ", "\u0000\u0001", "\n\t"])("rejects %j as empty", (raw) => {
    expect(() => sanitizeChatText(raw)).toThrow(GameError.emptyMessage);
  });
});

describe("parseMentionedColors", () => {
  const me = fakePlayer("p1", "Al", "red");
  const players = [
    me,
    fakePlayer("p2", "Alex", "green"),
    fakePlayer("p3", "Bo", "yellow"),
    fakePlayer("p4", "Computer", "blue", true),
  ];

  it("matches names case-insensitively at a word boundary", () => {
    expect(parseMentionedColors("hey @alex, @BO!", players, me._id).sort()).toEqual(["green", "yellow"]);
  });

  it("does not treat a longer name as a mention of its prefix", () => {
    const other = fakePlayer("p5", "Al", "red");
    const sender = fakePlayer("p6", "Zed", "blue");
    expect(parseMentionedColors("@Alex go", [other, fakePlayer("p2", "Alex", "green"), sender], sender._id)).toEqual(["green"]);
    expect(parseMentionedColors("@Alfie go", [other, sender], sender._id)).toEqual([]);
  });

  it("ignores self-mentions, bots and bare names without @", () => {
    expect(parseMentionedColors("@Al @Computer Bo", players, me._id)).toEqual([]);
  });

  it("reports each colour once", () => {
    expect(parseMentionedColors("@Bo @Bo @bo", players, me._id)).toEqual(["yellow"]);
  });
});

describe("sendMessage", () => {
  it("stores the sanitised text with the sender's name and colour", async () => {
    const room = await startedRoom(t, { players: 2 });
    await send(room.roomId, room.host, `  hello\u0000   world ${"!".repeat(MAX_CHAT_LEN)}`);
    const [msg] = await storedMessages(room.roomId);
    expect(msg!.text.startsWith("hello world !")).toBe(true);
    expect(msg!.text).toHaveLength(MAX_CHAT_LEN);
    expect(msg).toMatchObject({ name: "P1", color: "red" });
    expect(msg!.mentionedColors).toBeUndefined();
  });

  it("rejects empty messages without storing anything", async () => {
    const room = await startedRoom(t, { players: 2 });
    await expect(send(room.roomId, room.host, " \n\t ")).rejects.toThrow(GameError.emptyMessage);
    expect(await storedMessages(room.roomId)).toHaveLength(0);
  });

  it(`rate-limits each seat to one message per ${CHAT_MIN_INTERVAL_MS}ms`, async () => {
    const room = await startedRoom(t, { players: 2 });
    const other = room.clients.yellow!;
    await send(room.roomId, room.host, "one");
    await expect(send(room.roomId, room.host, "two")).rejects.toThrow(GameError.rateLimited);
    await send(room.roomId, other, "the limit is per seat");

    await advance(t, CHAT_MIN_INTERVAL_MS - 10);
    await expect(send(room.roomId, room.host, "still too soon")).rejects.toThrow(GameError.rateLimited);
    await advance(t, 10);
    await send(room.roomId, room.host, "three");

    expect((await storedMessages(room.roomId)).map((m) => m.text)).toEqual(["one", "the limit is per seat", "three"]);
  });

  it("rejects non-members, malformed sessions and bot seats", async () => {
    const room = await startedRoom(t, { players: 2 });
    await expect(send(room.roomId, OUTSIDER, "hi")).rejects.toThrow(GameError.notInRoom);
    await expect(send(room.roomId, "not-a-uuid", "hi")).rejects.toThrow(GameError.invalidSession);

    const solo = await t.mutation(api.rooms.createVsComputer, { clientId: clientId(50), name: "Solo", botCount: 1 });
    if (!("roomId" in solo)) throw new Error("pending");
    const bot = await t.run(async (ctx) =>
      (await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", solo.roomId))
        .collect()).find((p) => p.isBot),
    );
    if (!bot) throw new Error("no bot seat");
    await expect(send(solo.roomId, botClientId(solo.roomId, bot.color as Color), "beep")).rejects.toThrow(
      GameError.invalidSession,
    );

    // Even a bot doc that somehow carried a valid session id cannot chat.
    const spoofed = clientId(51);
    await t.run(async (ctx) => await ctx.db.patch(bot._id, { clientId: spoofed }));
    await expect(send(solo.roomId, spoofed, "beep")).rejects.toThrow(GameError.notInRoom);

    expect(await storedMessages(room.roomId)).toHaveLength(0);
    expect(await storedMessages(solo.roomId)).toHaveLength(0);
  });

  it(`keeps only the newest ${MAX_CHAT_MESSAGES} messages per room`, async () => {
    const room = await startedRoom(t, { players: 2 });
    const other = await startedRoom(t, { players: 2, clientBase: 10 });
    const player = await t.run(async (ctx) =>
      (await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room.roomId))
        .collect()).find((p) => p.color === "red")!,
    );
    const base = Date.now() - 1_000_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_CHAT_MESSAGES; i++) {
        await ctx.db.insert("chatMessages", {
          roomId: room.roomId,
          playerId: player._id,
          name: player.name,
          color: player.color,
          text: `old ${i}`,
          createdAt: base + i,
        });
      }
    });
    await send(other.roomId, other.host, "another room is untouched");

    await send(room.roomId, room.host, "newest");
    const kept = await storedMessages(room.roomId);
    expect(kept).toHaveLength(MAX_CHAT_MESSAGES);
    expect(kept[0]!.text).toBe("old 1");
    expect(kept.at(-1)!.text).toBe("newest");
    expect(await storedMessages(other.roomId)).toHaveLength(1);

    const visible = await list(room.roomId, room.host);
    expect(visible).toHaveLength(MAX_CHAT_MESSAGES);
    expect(visible.at(-1)).toMatchObject({ text: "newest", isMine: true });
  });
});

describe("listMessages visibility", () => {
  it("shows public messages to every seat, oldest first", async () => {
    const room = await startedRoom(t, { players: 3 });
    const yellow = room.clients.yellow!;
    await send(room.roomId, room.host, "first");
    await advance(t, CHAT_MIN_INTERVAL_MS);
    await send(room.roomId, yellow, "second");

    for (const client of Object.values(room.clients)) {
      const msgs = await list(room.roomId, client!);
      expect(msgs.map((m) => m.text)).toEqual(["first", "second"]);
      expect(msgs.every((m) => !m.isPrivate && m.mentionedColors.length === 0)).toBe(true);
    }
    const mine = await list(room.roomId, yellow);
    expect(mine.map((m) => m.isMine)).toEqual([false, true]);
  });

  it("an @mention is private to the sender and the mentioned seats", async () => {
    const room = await startedRoom(t, { players: 3 });
    const seats = await t.run(async (ctx) =>
      await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room.roomId))
        .collect(),
    );
    const target = seats.find((p) => p.clientId !== room.host)!;
    const bystander = seats.find((p) => p.clientId !== room.host && p._id !== target._id)!;

    await send(room.roomId, room.host, `@${target.name} psst`);

    const forSender = await list(room.roomId, room.host);
    expect(forSender).toHaveLength(1);
    expect(forSender[0]).toMatchObject({
      isMine: true,
      isPrivate: true,
      mentionsMe: false,
      mentionedColors: [target.color],
    });

    const forTarget = await list(room.roomId, target.clientId);
    expect(forTarget).toHaveLength(1);
    expect(forTarget[0]).toMatchObject({ isMine: false, isPrivate: true, mentionsMe: true });

    expect(await list(room.roomId, bystander.clientId)).toEqual([]);
  });

  it("other seats' private messages do not push public ones out of the window", async () => {
    const room = await startedRoom(t, { players: 3 });
    const red = (await t.run(async (ctx) =>
      (await ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", room.roomId))
        .collect()).find((p) => p.clientId === room.host)!,
    ));
    const base = Date.now() - 1_000_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("chatMessages", {
        roomId: room.roomId,
        playerId: red._id,
        name: red.name,
        color: red.color,
        text: "public",
        createdAt: base,
      });
      for (let i = 0; i < MAX_CHAT_MESSAGES - 1; i++) {
        await ctx.db.insert("chatMessages", {
          roomId: room.roomId,
          playerId: red._id,
          name: red.name,
          color: red.color,
          text: `dm ${i}`,
          createdAt: base + 1 + i,
          mentionedColors: ["yellow"],
        });
      }
    });

    const forGreen = await list(room.roomId, room.clients.green!);
    expect(forGreen.map((m) => m.text)).toEqual(["public"]);
    const forYellow = await list(room.roomId, room.clients.yellow!);
    expect(forYellow).toHaveLength(MAX_CHAT_MESSAGES);
  });

  it("non-members cannot read the room's chat", async () => {
    const room = await startedRoom(t, { players: 2 });
    await send(room.roomId, room.host, "secret");
    await expect(list(room.roomId, OUTSIDER)).rejects.toThrow(GameError.notInRoom);
  });
});
