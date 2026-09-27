/** Grid-aligned folk board art (see scripts/prepare-board-art.mjs). */
export const FOLK_BOARD_PNG = "/images/folk-ludo-board.png";
export const FOLK_BOARD_WEBP = "/images/folk-ludo-board.webp";
export const FOLK_BOARD_ALT =
  "Hand-painted traditional Ludo board with deer, elephant, swan, and camel corners";
/** Matches 15 × CELL in boardGeometry. */
export const BOARD_VIEW_SIZE = 1500;

/** Normalized inset inside viewBox; zero after prepare-script crop. */
export const BOARD_ART_INSET = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
} as const;

export function boardArtRect(viewSize: number) {
  const { left, top, right, bottom } = BOARD_ART_INSET;
  return {
    x: left * viewSize,
    y: top * viewSize,
    width: viewSize * (1 - left - right),
    height: viewSize * (1 - top - bottom),
  };
}
