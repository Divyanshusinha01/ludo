/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chat from "../chat.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as game from "../game.js";
import type * as lib_bot from "../lib/bot.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_ludo from "../lib/ludo.js";
import type * as lib_roomAuth from "../lib/roomAuth.js";
import type * as lib_session from "../lib/session.js";
import type * as rooms from "../rooms.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  cleanup: typeof cleanup;
  crons: typeof crons;
  game: typeof game;
  "lib/bot": typeof lib_bot;
  "lib/errors": typeof lib_errors;
  "lib/events": typeof lib_events;
  "lib/log": typeof lib_log;
  "lib/ludo": typeof lib_ludo;
  "lib/roomAuth": typeof lib_roomAuth;
  "lib/session": typeof lib_session;
  rooms: typeof rooms;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
