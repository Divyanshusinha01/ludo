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
import type * as gameEvents from "../gameEvents.js";
import type * as legacy from "../legacy.js";
import type * as lib_bot from "../lib/bot.js";
import type * as lib_colors from "../lib/colors.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_game_decide from "../lib/game/decide.js";
import type * as lib_game_errors from "../lib/game/errors.js";
import type * as lib_game_eventValidators from "../lib/game/eventValidators.js";
import type * as lib_game_events from "../lib/game/events.js";
import type * as lib_game_finish from "../lib/game/finish.js";
import type * as lib_game_index from "../lib/game/index.js";
import type * as lib_game_narrate from "../lib/game/narrate.js";
import type * as lib_game_reducer from "../lib/game/reducer.js";
import type * as lib_game_replay from "../lib/game/replay.js";
import type * as lib_game_state from "../lib/game/state.js";
import type * as lib_gameStore from "../lib/gameStore.js";
import type * as lib_gameSummaries from "../lib/gameSummaries.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_ludo from "../lib/ludo.js";
import type * as lib_roomAuth from "../lib/roomAuth.js";
import type * as lib_session from "../lib/session.js";
import type * as lib_teams from "../lib/teams.js";
import type * as rooms from "../rooms.js";
import type * as trouble from "../trouble.js";
import type * as voice from "../voice.js";

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
  gameEvents: typeof gameEvents;
  legacy: typeof legacy;
  "lib/bot": typeof lib_bot;
  "lib/colors": typeof lib_colors;
  "lib/errors": typeof lib_errors;
  "lib/events": typeof lib_events;
  "lib/game/decide": typeof lib_game_decide;
  "lib/game/errors": typeof lib_game_errors;
  "lib/game/eventValidators": typeof lib_game_eventValidators;
  "lib/game/events": typeof lib_game_events;
  "lib/game/finish": typeof lib_game_finish;
  "lib/game/index": typeof lib_game_index;
  "lib/game/narrate": typeof lib_game_narrate;
  "lib/game/reducer": typeof lib_game_reducer;
  "lib/game/replay": typeof lib_game_replay;
  "lib/game/state": typeof lib_game_state;
  "lib/gameStore": typeof lib_gameStore;
  "lib/gameSummaries": typeof lib_gameSummaries;
  "lib/log": typeof lib_log;
  "lib/ludo": typeof lib_ludo;
  "lib/roomAuth": typeof lib_roomAuth;
  "lib/session": typeof lib_session;
  "lib/teams": typeof lib_teams;
  rooms: typeof rooms;
  trouble: typeof trouble;
  voice: typeof voice;
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
