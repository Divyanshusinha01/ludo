import { v } from "convex/values";

export const colorValidator = v.union(
  v.literal("red"),
  v.literal("green"),
  v.literal("yellow"),
  v.literal("blue"),
);
