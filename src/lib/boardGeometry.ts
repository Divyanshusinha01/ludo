import type { Color } from "./player";
import {
  COLOR_START,
  SAFE_CELLS,
  stackFanOffset,
} from "../../convex/lib/ludo";

/** Board is a 15x15 grid. Cell centers in SVG viewBox 0..1500. */
const CELL = 100;
const N = 15;

export function cellCenter(col: number, row: number): { x: number; y: number } {
  return { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
}

/** Absolute track index 0..51 mapped to board cells (col, row). */
export const TRACK_CELLS: Array<[number, number]> = (() => {
  const cells: Array<[number, number]> = [];
  for (let c = 1; c <= 5; c++) cells.push([c, 6]);
  for (let r = 5; r >= 1; r--) cells.push([6, r]);
  cells.push([6, 0], [7, 0], [8, 0]);
  for (let r = 1; r <= 5; r++) cells.push([8, r]);
  for (let c = 9; c <= 13; c++) cells.push([c, 6]);
  cells.push([14, 6], [14, 7], [14, 8]);
  for (let c = 13; c >= 9; c--) cells.push([c, 8]);
  for (let r = 9; r <= 13; r++) cells.push([8, r]);
  cells.push([8, 14], [7, 14], [6, 14]);
  for (let r = 13; r >= 9; r--) cells.push([6, r]);
  for (let c = 5; c >= 1; c--) cells.push([c, 8]);
  cells.push([0, 8], [0, 7], [0, 6]);
  return cells;
})();

/** Home stretch cells for each colour (steps 51..55), centre is finished. */
export const HOME_STRETCH: Record<Color, Array<[number, number]>> = {
  red: [
    [1, 7],
    [2, 7],
    [3, 7],
    [4, 7],
    [5, 7],
  ],
  green: [
    [7, 1],
    [7, 2],
    [7, 3],
    [7, 4],
    [7, 5],
  ],
  yellow: [
    [13, 7],
    [12, 7],
    [11, 7],
    [10, 7],
    [9, 7],
  ],
  blue: [
    [7, 13],
    [7, 12],
    [7, 11],
    [7, 10],
    [7, 9],
  ],
};

export const YARD_SLOTS: Record<Color, Array<[number, number]>> = {
  red: [
    [1.5, 1.5],
    [3.5, 1.5],
    [1.5, 3.5],
    [3.5, 3.5],
  ],
  green: [
    [10.5, 1.5],
    [12.5, 1.5],
    [10.5, 3.5],
    [12.5, 3.5],
  ],
  yellow: [
    [10.5, 10.5],
    [12.5, 10.5],
    [10.5, 12.5],
    [12.5, 12.5],
  ],
  blue: [
    [1.5, 10.5],
    [3.5, 10.5],
    [1.5, 12.5],
    [3.5, 12.5],
  ],
};

export const CENTRE: [number, number] = [7, 7];

/**
 * Fixed slots inside each colour's home triangle so finished tokens
 * never overlap (index 0..3).
 */
export const HOME_FINISHED_SLOTS: Record<Color, Array<[number, number]>> = {
  // Red triangle: left of centre
  red: [
    [6.35, 7.15],
    [6.35, 7.85],
    [6.85, 7.0],
    [6.85, 8.0],
  ],
  // Green triangle: top of centre
  green: [
    [7.15, 6.35],
    [7.85, 6.35],
    [7.0, 6.85],
    [8.0, 6.85],
  ],
  // Yellow triangle: right of centre
  yellow: [
    [8.65, 7.15],
    [8.65, 7.85],
    [8.15, 7.0],
    [8.15, 8.0],
  ],
  // Blue triangle: bottom of centre
  blue: [
    [7.15, 8.65],
    [7.85, 8.65],
    [7.0, 8.15],
    [8.0, 8.15],
  ],
};

/** Re-export shared safe cells so board UI matches server rules. */
export const SAFE_SET = SAFE_CELLS;

/** Stable key for tokens that share a visual cell (for fan-out stacking). */
export function tokenStackKey(
  color: Color,
  index: number,
  steps: number,
): string {
  if (steps < 0) return `yard:${color}:${index}`;
  if (steps === 56) return `fin:${color}:${index}`;
  if (steps >= 51 && steps <= 55) return `home:${color}:${steps}`;
  const abs = (COLOR_START[color] + steps) % 52;
  return `track:${abs}`;
}

/** Base centre of a token before stack fan-out. */
export function tokenBasePosition(
  color: Color,
  index: number,
  steps: number,
): { x: number; y: number } {
  if (steps < 0) {
    const slot = YARD_SLOTS[color][index];
    if (!slot) return cellCenter(7, 7);
    return cellCenter(slot[0], slot[1]);
  }
  if (steps === 56) {
    const slot = HOME_FINISHED_SLOTS[color][index];
    if (!slot) return cellCenter(CENTRE[0], CENTRE[1]);
    return cellCenter(slot[0], slot[1]);
  }
  if (steps >= 51 && steps <= 55) {
    const cell = HOME_STRETCH[color][steps - 51];
    if (!cell) return cellCenter(7, 7);
    return cellCenter(cell[0], cell[1]);
  }
  const abs = (COLOR_START[color] + steps) % 52;
  const cell = TRACK_CELLS[abs];
  if (!cell) return cellCenter(7, 7);
  return cellCenter(cell[0], cell[1]);
}

export function tokenSvgPosition(
  color: Color,
  index: number,
  steps: number,
  stackIndex = 0,
  stackSize = 1,
): { x: number; y: number } {
  const base = tokenBasePosition(color, index, steps);
  const fan = stackFanOffset(stackIndex, stackSize);
  return { x: base.x + fan.x, y: base.y + fan.y };
}

export { CELL, N, stackFanOffset };
