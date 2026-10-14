import { turnActorColor } from "../ludo";
import type { LudoEvent } from "./eventValidators";
import type { GameState } from "./state";
import { seatByColor, teamPlayers } from "./state";

export function describeEvent(prev: GameState, event: LudoEvent): string[] {
  switch (event.eventType) {
    case "GAME_CREATED":
      return ["Room created"];
    case "PLAYER_JOINED":
      return [`${event.payload.seat.name} joined`];
    case "PLAYER_LEFT":
      return [
        `${seatByColor(prev, event.payload.color)?.name ?? event.payload.color} left`,
      ];
    case "GAME_STARTED":
      return ["Game started"];
    case "TURN_STARTED": {
      const seat = event.payload.seat;
      const actor = turnActorColor(seat, teamPlayers(prev), prev.mode);
      const actorSeat = seatByColor(prev, actor);
      const seatPlayer = seatByColor(prev, seat);
      if (
        prev.mode === "2v2" &&
        seat !== actor &&
        seatPlayer &&
        actorSeat
      ) {
        return [
          `${actorSeat.name} playing for ${seatPlayer.name} (${seat}'s turn)`,
        ];
      }
      if (actorSeat) return [`${actorSeat.name}'s turn`];
      return [`${seat}'s turn`];
    }
    case "DICE_ROLLED": {
      const name =
        seatByColor(prev, event.payload.color)?.name ?? event.payload.color;
      return [`${name} rolled ${event.payload.value}`];
    }
    case "ROLL_PASSED": {
      const from = seatByColor(prev, event.payload.from)?.name ?? event.payload.from;
      const to = seatByColor(prev, event.payload.to)?.name ?? event.payload.to;
      return [`${from} passed a roll to ${to}`];
    }
    case "PLAYER_REINSTATED":
      return [
        `${seatByColor(prev, event.payload.color)?.name ?? event.payload.color} rejoined`,
      ];
    case "TOKEN_MOVED":
    case "TOKEN_CAPTURED":
    case "EXTRA_TURN_GRANTED":
    case "TURN_ENDED":
    case "TURN_TIMED_OUT":
    case "PLAYER_ELIMINATED":
    case "PLAYER_FINISHED":
    case "TEAM_FINISHED":
    case "GAME_FINISHED":
      return [];
    default:
      return [];
  }
}
