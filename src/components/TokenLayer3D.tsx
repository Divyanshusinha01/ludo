"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  CELL,
  tokenStackKey,
  tokenSvgPosition,
} from "@/lib/boardGeometry";
import { COLOR_HEX, type Color } from "@/lib/player";
import { STEP_MS } from "@/hooks/useTokenAnimation";
import { prefersReducedMotion } from "@/lib/webgl";
import { bindWebGLFailure } from "@/lib/webgl3dState";

export type TokenLayerToken = {
  color: Color;
  index: number;
  steps: number;
};

type Fx = {
  captureKey?: string;
  homeKey?: string;
  leaveKey?: string;
};

type Props = {
  tokens: TokenLayerToken[];
  selectable?: number[];
  myColor?: Color | null;
  activeColor?: Color | null;
  fx?: Fx;
  /** Bumps to spawn a board-wide win confetti burst. */
  winBurstKey?: number | string | null;
  reducedMotion?: boolean;
};

const BOARD = 15 * CELL;

/** Sphere shading: light (highlight), mid, dark (rim). */
const TOKEN_3D: Record<Color, { light: string; mid: string; dark: string }> = {
  red: { light: "#ff8a80", mid: "#e53935", dark: "#b71c1c" },
  green: { light: "#81c784", mid: "#43a047", dark: "#2e7d32" },
  yellow: { light: "#ffe082", mid: "#e6a100", dark: "#b37a00" },
  blue: { light: "#64b5f6", mid: "#1e88e5", dark: "#0d47a1" },
};

function stackedPositions(tokens: TokenLayerToken[]) {
  const groups = new Map<string, TokenLayerToken[]>();
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

/** Orthographic camera mapped to SVG viewBox (Y increases downward). */
function SvgOrthoCamera() {
  const { camera, size } = useThree();

  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.left = 0;
    cam.right = BOARD;
    cam.top = 0;
    cam.bottom = BOARD;
    cam.near = -1000;
    cam.far = 1000;
    cam.position.set(0, 0, 200);
    cam.rotation.set(0, 0, 0);
    cam.zoom = 1;
    cam.updateProjectionMatrix();
  }, [camera, size]);

  return null;
}

function PawnMesh({
  color,
  finished,
  stacked,
  canSelect,
  isActiveTurn,
}: {
  color: Color;
  finished: boolean;
  stacked: boolean;
  canSelect: boolean;
  isActiveTurn: boolean;
}) {
  const palette = TOKEN_3D[color];
  const scale = finished ? 0.7 : stacked ? 0.9 : 1;
  const bodyR = 14 * scale;
  const baseR = 18 * scale;
  const headR = 11 * scale;
  const height = 26 * scale;

  return (
    <group>
      <mesh position={[0, 6, 0.5]}>
        <circleGeometry args={[baseR * 1.05, 24]} />
        <meshBasicMaterial color="#111" transparent opacity={0.28} />
      </mesh>

      {canSelect && (
        <mesh position={[0, 0, 1]}>
          <ringGeometry args={[30, 36, 32]} />
          <meshBasicMaterial color="#111" transparent opacity={0.55} />
        </mesh>
      )}
      {isActiveTurn && !canSelect && (
        <mesh position={[0, 0, 1]}>
          <ringGeometry args={[26, 30, 32]} />
          <meshBasicMaterial
            color={COLOR_HEX[color]}
            transparent
            opacity={0.55}
          />
        </mesh>
      )}

      <mesh position={[0, 0, height / 2 + 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[bodyR, baseR, height, 14]} />
        <meshStandardMaterial
          color={palette.mid}
          roughness={0.45}
          metalness={0.08}
        />
      </mesh>
      <mesh position={[0, 0, height + headR * 0.55]}>
        <sphereGeometry args={[headR, 16, 12]} />
        <meshStandardMaterial
          color={palette.light}
          roughness={0.35}
          metalness={0.05}
        />
      </mesh>
      <mesh position={[0, 0, height + headR * 1.35]}>
        <sphereGeometry args={[headR * 0.35, 10, 8]} />
        <meshStandardMaterial color={palette.dark} roughness={0.5} />
      </mesh>
    </group>
  );
}

type HopState = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
};

function useTokenHop(
  group: RefObject<THREE.Group | null>,
  hop: MutableRefObject<HopState | null>,
  enabled: boolean,
) {
  useFrame(() => {
    const g = group.current;
    const h = hop.current;
    if (!g || !h || !enabled) return;
    const t = Math.min(1, (performance.now() - h.start) / STEP_MS);
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = h.fromX + (h.toX - h.fromX) * ease;
    const y = h.fromY + (h.toY - h.fromY) * ease;
    const lift = Math.sin(Math.PI * t) * 28;
    g.position.set(x, y, lift);
    if (t >= 1) hop.current = null;
  });
}

function TokenPawn({
  token,
  x,
  y,
  stackSize,
  canSelect,
  isActiveTurn,
  hopEnabled,
}: {
  token: TokenLayerToken;
  x: number;
  y: number;
  stackSize: number;
  canSelect: boolean;
  isActiveTurn: boolean;
  hopEnabled: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const hop = useRef<HopState | null>(null);
  const prev = useRef({ x, y });
  const finished = token.steps === 56;
  const stacked = stackSize > 1;

  useLayoutEffect(() => {
    const g = group.current;
    if (!g) return;

    const dx = x - prev.current.x;
    const dy = y - prev.current.y;
    const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;

    if (moved && hopEnabled) {
      hop.current = {
        fromX: prev.current.x,
        fromY: prev.current.y,
        toX: x,
        toY: y,
        start: performance.now(),
      };
    } else {
      hop.current = null;
      g.position.set(x, y, 0);
    }
    prev.current = { x, y };
  }, [x, y, hopEnabled]);

  useTokenHop(group, hop, hopEnabled);

  return (
    <group ref={group} position={[x, y, 0]}>
      <PawnMesh
        color={token.color}
        finished={finished}
        stacked={stacked}
        canSelect={canSelect}
        isActiveTurn={isActiveTurn}
      />
    </group>
  );
}

function TokensScene({
  tokens,
  selectable,
  myColor,
  activeColor,
  hopEnabled,
}: {
  tokens: TokenLayerToken[];
  selectable: number[];
  myColor?: Color | null;
  activeColor?: Color | null;
  hopEnabled: boolean;
}) {
  const positions = useMemo(() => stackedPositions(tokens), [tokens]);
  const stackSizes = useMemo(() => {
    const groups = new Map<string, number>();
    for (const t of tokens) {
      const key = tokenStackKey(t.color, t.index, t.steps);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const out = new Map<string, number>();
    for (const t of tokens) {
      out.set(
        `${t.color}-${t.index}`,
        groups.get(tokenStackKey(t.color, t.index, t.steps)) ?? 1,
      );
    }
    return out;
  }, [tokens]);

  return (
    <>
      {tokens.map((t) => {
        const key = `${t.color}-${t.index}`;
        const pos =
          positions.get(key) ??
          tokenSvgPosition(t.color, t.index, t.steps);
        const canSelect =
          myColor === t.color && selectable.includes(t.index);
        const isActiveTurn = activeColor === t.color;
        return (
          <TokenPawn
            key={key}
            token={t}
            x={pos.x}
            y={pos.y}
            stackSize={stackSizes.get(key) ?? 1}
            canSelect={canSelect}
            isActiveTurn={!!isActiveTurn}
            hopEnabled={hopEnabled}
          />
        );
      })}
    </>
  );
}

type BurstKind = "capture" | "home" | "win";

type Burst = {
  id: number;
  kind: BurstKind;
  x: number;
  y: number;
  color: string;
  start: number;
};

type Particle = {
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  color: string;
};

function makeParticles(kind: BurstKind, color: string): Particle[] {
  const count = kind === "win" ? 48 : kind === "home" ? 18 : 14;
  const spread = kind === "win" ? 420 : 180;
  const up = kind === "win" ? 220 : 140;
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (0.35 + Math.random() * 0.65) * spread;
    particles.push({
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: (0.4 + Math.random()) * up,
      life: kind === "win" ? 1.1 + Math.random() * 0.5 : 0.45 + Math.random() * 0.25,
      size: kind === "win" ? 6 + Math.random() * 8 : 5 + Math.random() * 5,
      color:
        kind === "win"
          ? ["#e53935", "#43a047", "#e6a100", "#1e88e5", "#fff"][
              i % 5
            ]!
          : color,
    });
  }
  return particles;
}

function BurstEffect({
  burst,
  onDone,
}: {
  burst: Burst;
  onDone: (id: number) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const particles = useMemo(
    () => makeParticles(burst.kind, burst.color),
    [burst.kind, burst.color],
  );
  const meshes = useRef<THREE.Mesh[]>([]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const elapsed = (performance.now() - burst.start) / 1000;
    let alive = false;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const mesh = meshes.current[i];
      if (!mesh) continue;
      const t = elapsed / p.life;
      if (t >= 1) {
        mesh.visible = false;
        continue;
      }
      alive = true;
      const x = burst.x + p.vx * elapsed;
      const y = burst.y + p.vy * elapsed;
      const z = 20 + p.vz * elapsed - 180 * elapsed * elapsed;
      mesh.position.set(x, y, Math.max(2, z));
      mesh.scale.setScalar(p.size * (1 - t * 0.4));
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 1 - t;
    }
    // Keep delta referenced so React Compiler / lint stay happy.
    void delta;
    if (!alive && elapsed > 0.05) onDone(burst.id);
  });

  return (
    <group ref={group}>
      {particles.map((p, i) => (
        <mesh
          key={i}
          ref={(el) => {
            if (el) meshes.current[i] = el;
          }}
          position={[burst.x, burst.y, 24]}
        >
          <circleGeometry args={[1, 8]} />
          <meshBasicMaterial
            color={p.color}
            transparent
            opacity={1}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function EffectsLayer({
  tokens,
  fx,
  winBurstKey,
  enabled,
}: {
  tokens: TokenLayerToken[];
  fx?: Fx;
  winBurstKey?: number | string | null;
  enabled: boolean;
}) {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const idRef = useRef(0);
  const lastCapture = useRef<string | undefined>(undefined);
  const lastHome = useRef<string | undefined>(undefined);
  const lastWin = useRef<number | string | null | undefined>(undefined);
  const positions = useMemo(() => stackedPositions(tokens), [tokens]);

  useEffect(() => {
    if (!enabled) {
      setBursts([]);
      return;
    }

    const spawnAtKey = (key: string | undefined, kind: BurstKind) => {
      if (!key) return;
      const token = tokens.find((t) => `${t.color}-${t.index}` === key);
      const pos =
        positions.get(key) ??
        (token
          ? tokenSvgPosition(token.color, token.index, token.steps)
          : { x: BOARD / 2, y: BOARD / 2 });
      const color = token ? COLOR_HEX[token.color] : "#fff";
      idRef.current += 1;
      setBursts((prev) => [
        ...prev,
        {
          id: idRef.current,
          kind,
          x: pos.x,
          y: pos.y,
          color,
          start: performance.now(),
        },
      ]);
    };

    if (fx?.captureKey && fx.captureKey !== lastCapture.current) {
      lastCapture.current = fx.captureKey;
      spawnAtKey(fx.captureKey, "capture");
    }
    if (!fx?.captureKey) lastCapture.current = undefined;

    if (fx?.homeKey && fx.homeKey !== lastHome.current) {
      lastHome.current = fx.homeKey;
      spawnAtKey(fx.homeKey, "home");
    }
    if (!fx?.homeKey) lastHome.current = undefined;

    if (
      winBurstKey != null &&
      winBurstKey !== "" &&
      winBurstKey !== lastWin.current
    ) {
      lastWin.current = winBurstKey;
      idRef.current += 1;
      setBursts((prev) => [
        ...prev,
        {
          id: idRef.current,
          kind: "win",
          x: BOARD / 2,
          y: BOARD / 2,
          color: "#fff",
          start: performance.now(),
        },
      ]);
    }
  }, [enabled, fx?.captureKey, fx?.homeKey, winBurstKey, tokens, positions]);

  const clearBurst = useCallback((id: number) => {
    setBursts((prev) => prev.filter((b) => b.id !== id));
  }, []);

  if (!enabled) return null;

  return (
    <>
      {bursts.map((b) => (
        <BurstEffect key={b.id} burst={b} onDone={clearBurst} />
      ))}
    </>
  );
}

export function TokenLayer3D({
  tokens,
  selectable = [],
  myColor,
  activeColor,
  fx,
  winBurstKey = null,
  reducedMotion,
}: Props) {
  const motionOff = reducedMotion ?? prefersReducedMotion();
  const hopEnabled = !motionOff;
  const fxEnabled = !motionOff;

  return (
    <Canvas
      orthographic
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => bindWebGLFailure(gl)}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
        touchAction: "none",
      }}
      frameloop="always"
    >
      <SvgOrthoCamera />
      <ambientLight intensity={0.9} />
      <directionalLight position={[400, 200, 600]} intensity={1.05} />
      <directionalLight position={[-300, 800, 400]} intensity={0.35} />
      <TokensScene
        tokens={tokens}
        selectable={selectable}
        myColor={myColor}
        activeColor={activeColor}
        hopEnabled={hopEnabled}
      />
      <EffectsLayer
        tokens={tokens}
        fx={fx}
        winBurstKey={winBurstKey}
        enabled={fxEnabled}
      />
    </Canvas>
  );
}
