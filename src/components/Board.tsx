"use client";

import {
  CELL,
  HOME_STRETCH,
  SAFE_SET,
  TRACK_CELLS,
  tokenSvgPosition,
} from "@/lib/boardGeometry";
import { COLOR_HEX, type Color } from "@/lib/player";
import styles from "./Board.module.css";

export type BoardToken = {
  color: Color;
  index: number;
  steps: number;
};

type Props = {
  tokens: BoardToken[];
  selectable?: number[];
  myColor?: Color | null;
  onSelectToken?: (tokenIndex: number) => void;
};

const YARD_RECTS: Record<Color, { x: number; y: number }> = {
  red: { x: 0, y: 0 },
  green: { x: 9, y: 0 },
  yellow: { x: 9, y: 9 },
  blue: { x: 0, y: 9 },
};

function Star({ x, y }: { x: number; y: number }) {
  const s = 14;
  return (
    <path
      d={`M ${x} ${y - s} L ${x + 4} ${y - 4} L ${x + s} ${y - 4} L ${x + 6} ${y + 2} L ${x + 10} ${y + s} L ${x} ${y + 6} L ${x - 10} ${y + s} L ${x - 6} ${y + 2} L ${x - s} ${y - 4} L ${x - 4} ${y - 4} Z`}
      fill="#333"
      opacity={0.35}
    />
  );
}

export function Board({ tokens, selectable = [], myColor, onSelectToken }: Props) {
  const size = 15 * CELL;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={styles.svg}
        role="img"
        aria-label="Ludo board"
      >
        <rect width={size} height={size} fill="#f7f3e8" rx={24} />

        {/* Yard bases */}
        {(Object.keys(YARD_RECTS) as Color[]).map((color) => {
          const { x, y } = YARD_RECTS[color];
          return (
            <g key={color}>
              <rect
                x={x * CELL}
                y={y * CELL}
                width={6 * CELL}
                height={6 * CELL}
                fill={COLOR_HEX[color]}
                opacity={0.92}
              />
              <rect
                x={x * CELL + 60}
                y={y * CELL + 60}
                width={6 * CELL - 120}
                height={6 * CELL - 120}
                fill="#fff"
                rx={20}
              />
            </g>
          );
        })}

        {/* Cross paths background */}
        <rect x={6 * CELL} y={0} width={3 * CELL} height={size} fill="#fff" />
        <rect x={0} y={6 * CELL} width={size} height={3 * CELL} fill="#fff" />

        {/* Track cells */}
        {TRACK_CELLS.map(([c, r], i) => {
          const isStart =
            i === 0 || i === 13 || i === 26 || i === 39;
          const startColor: Color | null =
            i === 0 ? "red" : i === 13 ? "green" : i === 26 ? "yellow" : i === 39 ? "blue" : null;
          return (
            <g key={`t-${i}`}>
              <rect
                x={c * CELL + 2}
                y={r * CELL + 2}
                width={CELL - 4}
                height={CELL - 4}
                fill={startColor ? COLOR_HEX[startColor] : "#fff"}
                stroke="#d4cbb8"
                strokeWidth={2}
                rx={8}
                opacity={isStart ? 0.85 : 1}
              />
              {SAFE_SET.has(i) && !isStart && (
                <Star x={c * CELL + CELL / 2} y={r * CELL + CELL / 2} />
              )}
            </g>
          );
        })}

        {/* Home stretches */}
        {(Object.keys(HOME_STRETCH) as Color[]).map((color) =>
          HOME_STRETCH[color].map(([c, r], i) => (
            <rect
              key={`h-${color}-${i}`}
              x={c * CELL + 2}
              y={r * CELL + 2}
              width={CELL - 4}
              height={CELL - 4}
              fill={COLOR_HEX[color]}
              opacity={0.75}
              rx={8}
            />
          )),
        )}

        {/* Centre triangles */}
        <polygon
          points={`${6 * CELL},${6 * CELL} ${9 * CELL},${6 * CELL} ${7.5 * CELL},${7.5 * CELL}`}
          fill={COLOR_HEX.green}
        />
        <polygon
          points={`${9 * CELL},${6 * CELL} ${9 * CELL},${9 * CELL} ${7.5 * CELL},${7.5 * CELL}`}
          fill={COLOR_HEX.yellow}
        />
        <polygon
          points={`${6 * CELL},${9 * CELL} ${9 * CELL},${9 * CELL} ${7.5 * CELL},${7.5 * CELL}`}
          fill={COLOR_HEX.blue}
        />
        <polygon
          points={`${6 * CELL},${6 * CELL} ${6 * CELL},${9 * CELL} ${7.5 * CELL},${7.5 * CELL}`}
          fill={COLOR_HEX.red}
        />

        {/* Tokens */}
        {tokens.map((t) => {
          const pos = tokenSvgPosition(t.color, t.index, t.steps);
          const canSelect =
            myColor === t.color && selectable.includes(t.index);
          return (
            <g
              key={`${t.color}-${t.index}`}
              className={styles.token}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => {
                if (canSelect && onSelectToken) onSelectToken(t.index);
              }}
              style={{ cursor: canSelect ? "pointer" : "default" }}
            >
              <g className={canSelect ? styles.selectable : undefined}>
                {canSelect && (
                  <circle
                    r={32}
                    fill="none"
                    stroke="#111"
                    strokeWidth={3}
                    className={styles.pulse}
                  />
                )}
                <circle r={26} fill="#111" opacity={0.2} cy={3} />
                <circle
                  r={24}
                  fill={COLOR_HEX[t.color]}
                  stroke="#fff"
                  strokeWidth={4}
                />
                <circle r={8} fill="#fff" opacity={0.45} cx={-6} cy={-6} />
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
