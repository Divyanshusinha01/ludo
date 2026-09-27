/** User-facing game errors — keep messages short and non-internal. */
export const GameError = {
  missingSession: "Missing session",
  invalidSession: "Invalid session",
  roomNotFound: "Room not found",
  notInRoom: "Not in this room",
  roomFull: "Room is full",
  teamFull: "That team already has 2 players",
  needFullTeams: "Need 2 players on each team to start",
  teamRequired: "Choose Team A or Team B",
  seatTaken: "That seat is already taken",
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
  emptyMessage: "Type a message first",
  invalidDice: "Invalid dice state",
  vsComputerOnly: "This game is vs computer only",
  invalidBotCount: "Choose 1 to 3 computer opponents",
  nameTaken: "That name is already in this room",
  rejoinDenied: "Host denied your rejoin request",
  rejoinExpired: "Rejoin request expired — try again",
  passNotAllowed: "Pass is only available in 2v2 team mode",
  invalidPassTarget: "That's not your teammate's home",
  passNothingToPass: "Roll first — nothing to pass yet",
} as const;

export type GameErrorMessage = (typeof GameError)[keyof typeof GameError];

export function fail(message: GameErrorMessage): never {
  throw new Error(message);
}
