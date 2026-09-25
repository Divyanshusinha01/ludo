"use client";

import {
  CELL,
  HOME_STRETCH,
  SAFE_SET,
  TRACK_CELLS,
  tokenStackKey,
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
  /** Colour whose tokens should subtly glow (current turn). */
  activeColor?: Color | null;
  /** Finish ranks keyed by colour (1–4) for completed players. */
  finishRanks?: Partial<Record<Color, number>>;
  fx?: {
    captureKey?: string;
    homeKey?: string;
    leaveKey?: string;
  };
  onSelectToken?: (tokenIndex: number) => void;
};

const YARD_RECTS: Record<Color, { x: number; y: number }> = {
  red: { x: 0, y: 0 },
  green: { x: 9, y: 0 },
  yellow: { x: 9, y: 9 },
  blue: { x: 0, y: 9 },
};

/** Rank badge anchors inside each house's white inner square. */
const RANK_BADGE: Record<Color, { x: number; y: number }> = {
  red: { x: 3 * CELL, y: 3 * CELL },
  green: { x: 12 * CELL, y: 3 * CELL },
  yellow: { x: 12 * CELL, y: 12 * CELL },
  blue: { x: 3 * CELL, y: 12 * CELL },
};

function Star({ x, y }: { x: number; y: number }) {
  const s = 14;
  return (
    <path
      d={`M ${x} ${y - s} L ${x + 4} ${y - 4} L ${x + s} ${y - 4} L ${x + 6} ${y + 2} L ${x + 10} ${y + s} L ${x} ${y + 6} L ${x - 10} ${y + s} L ${x - 6} ${y + 2} L ${x - s} ${y - 4} L ${x - 4} ${y - 4} Z`}
      fill="#1e1810"
      opacity={0.45}
    />
  );
}

function stackedPositions(tokens: BoardToken[]) {
  const groups = new Map<string, BoardToken[]>();
  for (const t of tokens) {
    const key = tokenStackKey(t.color, t.index, t.steps);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [, group] of groups) {
    group.sort(
      (a, b) =>
        a.color.localeCompare(b.color) || a.index - b.index,
    );
    const size = group.length;
    group.forEach((t, i) => {
      positions.set(
        `${t.color}-${t.index}`,
        tokenSvgPosition(t.color, t.index, t.steps, i, size),
      );
    });
  }
  return positions;
}

export function Board({
  tokens,
  selectable = [],
  myColor,
  activeColor,
  finishRanks = {},
  fx,
  onSelectToken,
}: Props) {
  const size = 15 * CELL;
  const positions = stackedPositions(tokens);
  const interactive = selectable.length > 0 && !!onSelectToken;

  // Stack sizes for visual badges on overlapping tokens.
  const stackSizes = new Map<string, number>();
  {
    const groups = new Map<string, number>();
    for (const t of tokens) {
      const key = tokenStackKey(t.color, t.index, t.steps);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const t of tokens) {
      stackSizes.set(
        `${t.color}-${t.index}`,
        groups.get(tokenStackKey(t.color, t.index, t.steps)) ?? 1,
      );
    }
  }

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={styles.svg}
        role={interactive ? "application" : "img"}
        aria-label="Ludo board"
      >
        <rect width={size} height={size} fill="#f7f3e8" rx={24} />

        {(Object.keys(YARD_RECTS) as Color[]).map((color) => {
          const { x, y } = YARD_RECTS[color];
          const rank = finishRanks[color];
          const badge = RANK_BADGE[color];
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
                opacity={rank ? 0.92 : 1}
              />
              {rank != null && (
                <g
                  className={styles.rankBadge}
                  aria-label={`${color} finished rank ${rank}`}
                >
                  <text
                    x={badge.x}
                    y={badge.y - 18}
                    textAnchor="middle"
                    className={styles.rankHash}
                    fill={COLOR_HEX[color]}
                  >
                    #{rank}
                  </text>
                  <text
                    x={badge.x}
                    y={badge.y + 22}
                    textAnchor="middle"
                    className={styles.rankLabel}
                    fill="#1e1810"
                  >
                    FINISHED
                  </text>
                </g>
              )}
            </g>
          );
        })}

        <rect x={6 * CELL} y={0} width={3 * CELL} height={size} fill="#fff" />
        <rect x={0} y={6 * CELL} width={size} height={3 * CELL} fill="#fff" />

        {TRACK_CELLS.map(([c, r], i) => {
          const isStart =
            i === 0 || i === 13 || i === 26 || i === 39;
          const startColor: Color | null =
            i === 0
              ? "red"
              : i === 13
                ? "green"
                : i === 26
                  ? "yellow"
                  : i === 39
                    ? "blue"
                    : null;
          const safe = SAFE_SET.has(i);
          return (
            <g key={`t-${i}`}>
              <rect
                x={c * CELL + 2}
                y={r * CELL + 2}
                width={CELL - 4}
                height={CELL - 4}
                fill={startColor ? COLOR_HEX[startColor] : safe ? "#efe6c8" : "#fff"}
                stroke={safe ? "#c4a35a" : "#d4cbb8"}
                strokeWidth={safe ? 3 : 2}
                rx={8}
                opacity={isStart ? 0.85 : 1}
              />
              {safe && !isStart && (
                <Star x={c * CELL + CELL / 2} y={r * CELL + CELL / 2} />
              )}
            </g>
          );
        })}

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

        {tokens.map((t) => {
          const key = `${t.color}-${t.index}`;
          const pos =
            positions.get(key) ??
            tokenSvgPosition(t.color, t.index, t.steps);
          const canSelect =
            myColor === t.color && selectable.includes(t.index);
          const isActiveTurn = activeColor === t.color;
          const finished = t.steps === 56;
          const stacked = (stackSizes.get(key) ?? 1) > 1;
          // Smaller disc when home so all four fit inside the centre triangle.
          const bodyR = finished ? 16 : stacked ? 22 : 24;
          const shadowR = finished ? 17 : stacked ? 24 : 26;
          const strokeW = finished
            ? t.color === "yellow"
              ? 3
              : 2.5
            : t.color === "yellow"
              ? 5
              : 4;
          const fxClass =
            fx?.captureKey === key
              ? styles.capture
              : fx?.homeKey === key
                ? styles.homePop
                : fx?.leaveKey === key
                  ? styles.leavePop
                  : undefined;

          return (
            <g
              key={key}
              className={`${styles.token} ${fxClass ?? ""}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              role={canSelect ? "button" : undefined}
              tabIndex={canSelect ? 0 : undefined}
              aria-label={
                canSelect
                  ? `Move ${t.color} token ${t.index + 1}`
                  : undefined
              }
              onClick={(e) => {
                if (!canSelect || !onSelectToken) return;
                e.stopPropagation();
                onSelectToken(t.index);
              }}
              onKeyDown={(e) => {
                if (!canSelect || !onSelectToken) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectToken(t.index);
                }
              }}
              style={{ cursor: canSelect ? "pointer" : "default" }}
            >
              <g
                className={`${canSelect ? styles.selectable : ""} ${isActiveTurn && !canSelect ? styles.turnGlow : ""}`}
              >
                {canSelect && (
                  <circle
                    r={38}
                    fill="none"
                    stroke="#111"
                    strokeWidth={3}
                    className={styles.pulse}
                  />
                )}
                {isActiveTurn && !canSelect && (
                  <circle
                    r={32}
                    fill="none"
                    stroke={COLOR_HEX[t.color]}
                    strokeWidth={3}
                    className={styles.turnRing}
                    opacity={0.7}
                  />
                )}
                {/* Generous invisible hit target so stacked tokens stay tappable */}
                {canSelect && <circle r={44} fill="transparent" />}
                <circle
                  r={shadowR}
                  fill="#111"
                  opacity={0.2}
                  cy={finished ? 2 : 3}
                />
                <circle
                  r={bodyR}
                  fill={COLOR_HEX[t.color]}
                  stroke="#1e1810"
                  strokeWidth={strokeW}
                />
                <circle
                  r={finished ? 5 : 8}
                  fill="#fff"
                  opacity={0.45}
                  cx={finished ? -4 : -6}
                  cy={finished ? -4 : -6}
                />
                {/* Token number helps distinguish overlaps of the same colour */}
                {!finished && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={styles.tokenNum}
                    fill="#fff"
                    stroke="#1e1810"
                    strokeWidth={2}
                    paintOrder="stroke"
                  >
                    {t.index + 1}
                  </text>
                )}
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
