import type { Color } from "./player";

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

export const SAFE_SET = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function tokenSvgPosition(
  color: Color,
  index: number,
  steps: number,
): { x: number; y: number } {
  if (steps < 0) {
    const [c, r] = YARD_SLOTS[color][index]!;
    return cellCenter(c, r);
  }
  if (steps === 56) {
    const offsets = [
      [-18, -18],
      [18, -18],
      [-18, 18],
      [18, 18],
    ];
    const [ox, oy] = offsets[index]!;
    const base = cellCenter(CENTRE[0], CENTRE[1]);
    return { x: base.x + ox, y: base.y + oy };
  }
  if (steps >= 51 && steps <= 55) {
    const [c, r] = HOME_STRETCH[color][steps - 51]!;
    return cellCenter(c, r);
  }
  const abs = (startOf(color) + steps) % 52;
  const cell = TRACK_CELLS[abs];
  if (!cell) return cellCenter(7, 7);
  return cellCenter(cell[0], cell[1]);
}

function startOf(color: Color): number {
  return { red: 0, green: 13, yellow: 26, blue: 39 }[color];
}

export { CELL, N };
