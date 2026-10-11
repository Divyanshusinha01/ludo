"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, type PointerEvent } from "react";
import {
  boardArtRect,
  FOLK_BOARD_PNG,
  FOLK_BOARD_WEBP,
} from "@/lib/boardAsset";
import { CELL, tokenStackKey, tokenSvgPosition } from "@/lib/boardGeometry";
import { useCanUse3DBoard } from "@/hooks/useCanUse3D";
import { disableWebGL3D } from "@/lib/webgl3dState";
import { COLOR_HEX, COLOR_LABEL, type Color } from "@/lib/player";
import { rankHouseLabel } from "../../convex/lib/ludo";
import styles from "./Board.module.css";

const TokenLayer3D = dynamic(
  () =>
    import("./TokenLayer3D")
      .then((m) => m.TokenLayer3D)
      .catch(() => {
        // The service worker only precaches chunks named in page HTML, so this
        // lazy chunk can be missing offline; fall back to the SVG tokens.
        disableWebGL3D();
        return function NoTokenLayer3D() {
          return null;
        };
      }),
  { ssr: false },
);

export type BoardToken = {
  color: Color;
  index: number;
  steps: number;
};

/** Invisible hit radius in SVG units — large enough for fingers. */
const TOKEN_HIT_RADIUS = 48;

/** Sphere shading: light (highlight), mid, dark (rim). */
const TOKEN_3D: Record<Color, { light: string; mid: string; dark: string }> = {
  red: { light: "#ff8a80", mid: "#e53935", dark: "#b71c1c" },
  green: { light: "#81c784", mid: "#43a047", dark: "#2e7d32" },
  yellow: { light: "#ffe082", mid: "#e6a100", dark: "#b37a00" },
  blue: { light: "#64b5f6", mid: "#1e88e5", dark: "#0d47a1" },
};

const TOKEN_COLORS: Color[] = ["red", "green", "yellow", "blue"];

type Props = {
  tokens: BoardToken[];
  selectable?: number[];
  myColor?: Color | null;
  /** Colour whose tokens should subtly glow (current turn). */
  activeColor?: Color | null;
  /** Finish ranks keyed by colour (1–4) for completed / ranked players. */
  finishRanks?: Partial<Record<Color, number>>;
  /** Seated player count — used for WINNER / LOSE house labels. */
  playerCount?: number;
  fx?: {
    captureKey?: string;
    homeKey?: string;
    leaveKey?: string;
  };
  /** Prefer 3D pawns when WebGL is available (default true). */
  render3DTokens?: boolean;
  /** Bumps to spawn a board-wide win confetti burst. */
  winBurstKey?: number | string | null;
  /** When set, overrides `selectable` + `myColor` (2v2 multi-colour moves). */
  selectableTokens?: Array<{ color: Color; index: number }>;
  onSelectToken?: (color: Color, tokenIndex: number) => void;
  /** 2v2: teammate home to tap for passing the turn. */
  passTargetColor?: Color | null;
  passTargetAriaLabel?: string;
  onPassTurn?: (color: Color) => void;
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

function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: ((clientX - rect.left) / rect.width) * vb.width,
      y: ((clientY - rect.top) / rect.height) * vb.height,
    };
  }
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function tokenIsSelectable(
  color: Color,
  index: number,
  selectable: number[],
  selectableTokens: Array<{ color: Color; index: number }> | undefined,
  myColor: Color | null | undefined,
): boolean {
  if (selectableTokens && selectableTokens.length > 0) {
    return selectableTokens.some((m) => m.color === color && m.index === index);
  }
  return myColor === color && selectable.includes(index);
}

function pointInYard(px: number, py: number, color: Color): boolean {
  const { x, y } = YARD_RECTS[color];
  const left = x * CELL;
  const top = y * CELL;
  const side = 6 * CELL;
  return px >= left && px <= left + side && py >= top && py <= top + side;
}

export function Board({
  tokens,
  selectable = [],
  selectableTokens,
  myColor,
  activeColor,
  finishRanks = {},
  playerCount = 0,
  fx,
  render3DTokens = true,
  winBurstKey = null,
  onSelectToken,
  passTargetColor = null,
  passTargetAriaLabel,
  onPassTurn,
}: Props) {
  const size = 15 * CELL;
  const art = boardArtRect(size);
  const positions = stackedPositions(tokens);
  const svgRef = useRef<SVGSVGElement>(null);
  const hasSelectable =
    (selectableTokens?.length ?? 0) > 0 || selectable.length > 0;
  const canPassTurn = !!passTargetColor && !!onPassTurn;
  const interactive =
    (hasSelectable && !!onSelectToken) || canPassTurn;
  const use3D = useCanUse3DBoard() && render3DTokens;

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

  const pickSelectableAt = useCallback(
    (
      clientX: number,
      clientY: number,
    ): { color: Color; index: number } | null => {
      if (!interactive || !onSelectToken) return null;
      const svg = svgRef.current;
      if (!svg) return null;
      const point = clientToSvg(svg, clientX, clientY);
      const candidates = tokens
        .filter((t) =>
          tokenIsSelectable(
            t.color,
            t.index,
            selectable,
            selectableTokens,
            myColor,
          ),
        )
        .map((t) => {
          const pos =
            positions.get(`${t.color}-${t.index}`) ??
            tokenSvgPosition(t.color, t.index, t.steps);
          return { color: t.color, index: t.index, x: pos.x, y: pos.y };
        });
      let best: { color: Color; index: number; dist: number } | null = null;
      for (const c of candidates) {
        const dist = Math.hypot(point.x - c.x, point.y - c.y);
        if (dist > TOKEN_HIT_RADIUS) continue;
        if (
          !best ||
          dist < best.dist ||
          (dist === best.dist && c.index < best.index)
        ) {
          best = { color: c.color, index: c.index, dist };
        }
      }
      return best ? { color: best.color, index: best.index } : null;
    },
    [
      interactive,
      myColor,
      onSelectToken,
      positions,
      selectable,
      selectableTokens,
      tokens,
    ],
  );

  const handlePointer = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      if (!interactive) return;
      // Only primary button / touch.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (onSelectToken) {
        const hit = pickSelectableAt(e.clientX, e.clientY);
        if (hit != null) {
          e.preventDefault();
          e.stopPropagation();
          onSelectToken(hit.color, hit.index);
          return;
        }
      }
      if (canPassTurn && passTargetColor && onPassTurn) {
        const svg = svgRef.current;
        if (!svg) return;
        const point = clientToSvg(svg, e.clientX, e.clientY);
        if (!pointInYard(point.x, point.y, passTargetColor)) return;
        e.preventDefault();
        e.stopPropagation();
        onPassTurn(passTargetColor);
      }
    },
    [
      canPassTurn,
      interactive,
      onPassTurn,
      onSelectToken,
      passTargetColor,
      pickSelectableAt,
    ],
  );

  return (
    <div className={styles.wrap}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size} ${size}`}
        className={styles.svg}
        role={interactive ? "application" : "img"}
        aria-label="Ludo board"
        style={interactive ? { cursor: "pointer" } : undefined}
        onPointerDown={handlePointer}
      >
        <defs>
          {TOKEN_COLORS.map((color) => {
            const g = TOKEN_3D[color];
            return (
              <radialGradient
                key={`grad-${color}`}
                id={`tokenGrad-${color}`}
                fx="35%"
                fy="30%"
                cx="50%"
                cy="50%"
                r="65%"
              >
                <stop offset="0%" stopColor={g.light} />
                <stop offset="45%" stopColor={g.mid} />
                <stop offset="100%" stopColor={g.dark} />
              </radialGradient>
            );
          })}
          <radialGradient
            id="tokenSpecular"
            fx="40%"
            fy="35%"
            cx="50%"
            cy="50%"
            r="50%"
          >
            <stop offset="0%" stopColor="#fff" stopOpacity={0.9} />
            <stop offset="55%" stopColor="#fff" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <radialGradient
            id="tokenRimShade"
            fx="50%"
            fy="85%"
            cx="50%"
            cy="70%"
            r="60%"
          >
            <stop offset="0%" stopColor="#000" stopOpacity={0.35} />
            <stop offset="70%" stopColor="#000" stopOpacity={0} />
          </radialGradient>
          <filter
            id="tokenShadowBlur"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" />
          </filter>
        </defs>

        {/* SVG has no <picture>; PNG under WebP mirrors hero WebP-first fallback. */}
        <image
          href={FOLK_BOARD_PNG}
          x={art.x}
          y={art.y}
          width={art.width}
          height={art.height}
          preserveAspectRatio="xMidYMid meet"
        />
        <image
          href={FOLK_BOARD_WEBP}
          x={art.x}
          y={art.y}
          width={art.width}
          height={art.height}
          preserveAspectRatio="xMidYMid meet"
        />

        {(Object.keys(YARD_RECTS) as Color[]).map((color) => {
          const { x, y } = YARD_RECTS[color];
          const rank = finishRanks[color];
          const badge = RANK_BADGE[color];
          const label =
            rank != null ? rankHouseLabel(rank, playerCount) : null;
          const isPassTarget = passTargetColor === color;
          const badgeH = label ? 88 : 56;
          return (
            <g key={color}>
              {isPassTarget && (
                <rect
                  x={x * CELL + 8}
                  y={y * CELL + 8}
                  width={6 * CELL - 16}
                  height={6 * CELL - 16}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={10}
                  rx={24}
                  className={styles.passTargetRing}
                  aria-label={passTargetAriaLabel}
                />
              )}
              {rank != null && (
                <g
                  className={styles.rankBadge}
                  aria-label={
                    label
                      ? `${color} rank ${rank} ${label}`
                      : `${color} finished rank ${rank}`
                  }
                >
                  <rect
                    x={badge.x - 118}
                    y={badge.y - (label ? 52 : 36)}
                    width={236}
                    height={badgeH}
                    rx={16}
                    fill="rgba(255, 252, 245, 0.88)"
                    stroke="rgba(30, 24, 16, 0.12)"
                    strokeWidth={2}
                  />
                  <text
                    x={badge.x}
                    y={label ? badge.y - 18 : badge.y}
                    textAnchor="middle"
                    dominantBaseline={label ? undefined : "central"}
                    className={styles.rankHash}
                    fill={COLOR_HEX[color]}
                  >
                    #{rank}
                  </text>
                  {label && (
                    <text
                      x={badge.x}
                      y={badge.y + 22}
                      textAnchor="middle"
                      className={styles.rankLabel}
                      fill="#1e1810"
                    >
                      {label}
                    </text>
                  )}
                </g>
              )}
            </g>
          );
        })}

        {!use3D &&
          tokens.map((t) => {
          const key = `${t.color}-${t.index}`;
          const pos =
            positions.get(key) ??
            tokenSvgPosition(t.color, t.index, t.steps);
          const canSelect = tokenIsSelectable(
            t.color,
            t.index,
            selectable,
            selectableTokens,
            myColor,
          );
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
              // Hit testing is geometric on the SVG; tokens are visual only.
              style={{ pointerEvents: "none" }}
              aria-hidden
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
                {/* Visual-only generous target ring (selection uses resolveTokenHit) */}
                {canSelect && (
                  <circle r={TOKEN_HIT_RADIUS} fill="transparent" />
                )}
                <ellipse
                  rx={shadowR * 0.95}
                  ry={shadowR * 0.45}
                  fill="#111"
                  opacity={0.28}
                  cy={finished ? bodyR * 0.55 : bodyR * 0.65}
                  filter="url(#tokenShadowBlur)"
                />
                <circle
                  r={bodyR}
                  fill={`url(#tokenGrad-${t.color})`}
                  stroke="#1e1810"
                  strokeWidth={strokeW}
                />
                <circle
                  r={bodyR - strokeW * 0.5}
                  fill="url(#tokenRimShade)"
                  pointerEvents="none"
                />
                <ellipse
                  rx={finished ? 7 : 10}
                  ry={finished ? 5 : 7}
                  fill="url(#tokenSpecular)"
                  cx={finished ? -5 : -7}
                  cy={finished ? -6 : -8}
                  pointerEvents="none"
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

        {/* Keyboard and screen-reader targets; pointer input keeps the geometric hit test. */}
        {interactive &&
          onSelectToken &&
          tokens
            .filter((t) =>
              tokenIsSelectable(
                t.color,
                t.index,
                selectable,
                selectableTokens,
                myColor,
              ),
            )
            .map((t) => {
              const pos =
                positions.get(`${t.color}-${t.index}`) ??
                tokenSvgPosition(t.color, t.index, t.steps);
              return (
                <circle
                  key={`focus-${t.color}-${t.index}`}
                  cx={pos.x}
                  cy={pos.y}
                  r={34}
                  fill="transparent"
                  pointerEvents="none"
                  className={styles.tokenFocus}
                  role="button"
                  tabIndex={0}
                  aria-label={`Move ${COLOR_LABEL[t.color]} token ${t.index + 1}`}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onSelectToken(t.color, t.index);
                  }}
                />
              );
            })}
      </svg>
      {use3D && (
        <div className={styles.layer3d} aria-hidden>
          <TokenLayer3D
            tokens={tokens}
            selectable={selectable}
            selectableTokens={selectableTokens}
            myColor={myColor}
            activeColor={activeColor}
            fx={fx}
            winBurstKey={winBurstKey}
          />
        </div>
      )}
    </div>
  );
}
