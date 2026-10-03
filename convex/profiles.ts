import { query } from "./_generated/server";
import { v } from "convex/values";
import { optionalAccount } from "./lib/auth";
import { normalizeUsername } from "./lib/authShared";
import { publicProfileValidator, toPublicProfile } from "./lib/profile";

export const getMine = query({
  args: {},
  returns: v.union(publicProfileValidator, v.null()),
  handler: async (ctx) => {
    const signedIn = await optionalAccount(ctx);
    return signedIn ? toPublicProfile(signedIn.profile) : null;
  },
});

export const getPublic = query({
  args: { username: v.string() },
  returns: v.union(publicProfileValidator, v.null()),
  handler: async (ctx, args) => {
    const username = normalizeUsername(args.username);
    if (!username || username.length > 40) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    return profile ? toPublicProfile(profile) : null;
  },
});

/** Public profile of the account seated as `playerId`; null for guests and bots. */
export const getForPlayer = query({
  args: { playerId: v.id("players") },
  returns: v.union(publicProfileValidator, v.null()),
  handler: async (ctx, args) => {
    const player = await ctx.db.get(args.playerId);
    if (!player?.accountId || player.isBot) return null;
    const accountId = player.accountId;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    return profile ? toPublicProfile(profile) : null;
  },
});
