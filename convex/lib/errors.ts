/** User-facing game errors — keep messages short and non-internal. */
export const GameError = {
  missingSession: "Missing session",
  invalidSession: "Invalid session",
  roomNotFound: "Room not found",
  notInRoom: "Not in this room",
  roomFull: "Room is full",
  gameStarted: "Game already started",
  gameNotPlaying: "Game not in progress",
  gameFinished: "Game already finished",
  notFinished: "Game is not finished",
  notYourTurn: "Not your turn",
  eliminated: "You are eliminated",
  diceAlreadyRolled: "Dice already rolled",
  rollFirst: "Roll the dice first",
  illegalMove: "Illegal move",
  turnExpired: "Turn expired",
  staleAction: "Stale action — refresh and try again",
  rateLimited: "Slow down — try again in a moment",
  needPlayers: "Need at least 2 players to start",
  onlyHost: "Only the host can do that",
  invalidCode: "Invalid room code",
  invalidName: "Enter a valid name",
  invalidDice: "Invalid dice state",
} as const;

export type GameErrorMessage = (typeof GameError)[keyof typeof GameError];

export function fail(message: GameErrorMessage): never {
  throw new Error(message);
}
