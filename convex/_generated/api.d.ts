/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authStore from "../authStore.js";
import type * as chat from "../chat.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as game from "../game.js";
import type * as gameEvents from "../gameEvents.js";
import type * as history from "../history.js";
import type * as legacy from "../legacy.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authShared from "../lib/authShared.js";
import type * as lib_bot from "../lib/bot.js";
import type * as lib_colors from "../lib/colors.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_game_canonical from "../lib/game/canonical.js";
import type * as lib_game_decide from "../lib/game/decide.js";
import type * as lib_game_errors from "../lib/game/errors.js";
import type * as lib_game_eventValidators from "../lib/game/eventValidators.js";
import type * as lib_game_events from "../lib/game/events.js";
import type * as lib_game_finish from "../lib/game/finish.js";
import type * as lib_game_index from "../lib/game/index.js";
import type * as lib_game_narrate from "../lib/game/narrate.js";
import type * as lib_game_reducer from "../lib/game/reducer.js";
import type * as lib_game_replay from "../lib/game/replay.js";
import type * as lib_game_shape from "../lib/game/shape.js";
import type * as lib_game_state from "../lib/game/state.js";
import type * as lib_gameStore from "../lib/gameStore.js";
import type * as lib_gameSummaries from "../lib/gameSummaries.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_ludo from "../lib/ludo.js";
import type * as lib_matchQueue from "../lib/matchQueue.js";
import type * as lib_matchmaking from "../lib/matchmaking.js";
import type * as lib_metrics from "../lib/metrics.js";
import type * as lib_profile from "../lib/profile.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_rating from "../lib/rating.js";
import type * as lib_roomAuth from "../lib/roomAuth.js";
import type * as lib_roomFactory from "../lib/roomFactory.js";
import type * as lib_session from "../lib/session.js";
import type * as lib_settlement from "../lib/settlement.js";
import type * as lib_spectate from "../lib/spectate.js";
import type * as matchmaking from "../matchmaking.js";
import type * as ops from "../ops.js";
import type * as profiles from "../profiles.js";
import type * as rooms from "../rooms.js";
import type * as spectate from "../spectate.js";
import type * as trouble from "../trouble.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authStore: typeof authStore;
  chat: typeof chat;
  cleanup: typeof cleanup;
  crons: typeof crons;
  game: typeof game;
  gameEvents: typeof gameEvents;
  history: typeof history;
  legacy: typeof legacy;
  "lib/auth": typeof lib_auth;
  "lib/authShared": typeof lib_authShared;
  "lib/bot": typeof lib_bot;
  "lib/colors": typeof lib_colors;
  "lib/errors": typeof lib_errors;
  "lib/events": typeof lib_events;
  "lib/game/canonical": typeof lib_game_canonical;
  "lib/game/decide": typeof lib_game_decide;
  "lib/game/errors": typeof lib_game_errors;
  "lib/game/eventValidators": typeof lib_game_eventValidators;
  "lib/game/events": typeof lib_game_events;
  "lib/game/finish": typeof lib_game_finish;
  "lib/game/index": typeof lib_game_index;
  "lib/game/narrate": typeof lib_game_narrate;
  "lib/game/reducer": typeof lib_game_reducer;
  "lib/game/replay": typeof lib_game_replay;
  "lib/game/shape": typeof lib_game_shape;
  "lib/game/state": typeof lib_game_state;
  "lib/gameStore": typeof lib_gameStore;
  "lib/gameSummaries": typeof lib_gameSummaries;
  "lib/log": typeof lib_log;
  "lib/ludo": typeof lib_ludo;
  "lib/matchQueue": typeof lib_matchQueue;
  "lib/matchmaking": typeof lib_matchmaking;
  "lib/metrics": typeof lib_metrics;
  "lib/profile": typeof lib_profile;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/rating": typeof lib_rating;
  "lib/roomAuth": typeof lib_roomAuth;
  "lib/roomFactory": typeof lib_roomFactory;
  "lib/session": typeof lib_session;
  "lib/settlement": typeof lib_settlement;
  "lib/spectate": typeof lib_spectate;
  matchmaking: typeof matchmaking;
  ops: typeof ops;
  profiles: typeof profiles;
  rooms: typeof rooms;
  spectate: typeof spectate;
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
