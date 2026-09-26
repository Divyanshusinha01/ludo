"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { COLOR_HEX, type Color } from "@/lib/player";

/** Pip indices per face — same layout as Dice.tsx CSS grid. */
const FACES: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const FACE_NORMALS: Record<number, THREE.Vector3> = {
  1: new THREE.Vector3(0, 1, 0),
  2: new THREE.Vector3(0, 0, 1),
  3: new THREE.Vector3(1, 0, 0),
  4: new THREE.Vector3(-1, 0, 0),
  5: new THREE.Vector3(0, 0, -1),
  6: new THREE.Vector3(0, -1, 0),
};

const SIZE = 1.05;
const HALF = SIZE / 2;
const PIP_R = 0.09;
const PIP_GAP = 0.28;

function pipLocalXY(index: number): [number, number] {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return [(col - 1) * PIP_GAP, (1 - row) * PIP_GAP];
}

function quaternionForFace(value: number): THREE.Quaternion {
  const v = value >= 1 && value <= 6 ? value : 1;
  const normal = FACE_NORMALS[v]!.clone().normalize();
  const target = new THREE.Vector3(0, 0, 1);
  return new THREE.Quaternion().setFromUnitVectors(normal, target);
}

function FacePips({
  face,
  color,
}: {
  face: number;
  color: string;
}) {
  const pips = FACES[face] ?? [];
  const normal = FACE_NORMALS[face]!;
  const quat = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
    return q;
  }, [normal]);

  return (
    <group
      position={normal.clone().multiplyScalar(HALF + 0.01)}
      quaternion={quat}
    >
      {pips.map((i) => {
        const [x, y] = pipLocalXY(i);
        return (
          <mesh key={i} position={[x, y, 0]}>
            <circleGeometry args={[PIP_R, 16]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function DieMesh({
  value,
  color,
  rolling,
}: {
  value: number | null;
  color: Color;
  rolling?: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const spinAxis = useRef(
    new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize(),
  );
  const spinSpeed = useRef(12 + Math.random() * 6);
  const settling = useRef(false);
  const settleFrom = useRef(new THREE.Quaternion());
  const settleTo = useRef(new THREE.Quaternion());
  const settleT = useRef(1);
  const wasRolling = useRef(false);
  const accent = COLOR_HEX[color];
  const body = useMemo(
    () =>
      new THREE.Color(accent).lerp(new THREE.Color("#ffffff"), 0.18).getStyle(),
    [accent],
  );

  useEffect(() => {
    if (rolling) {
      wasRolling.current = true;
      settling.current = false;
      spinAxis.current = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5,
      ).normalize();
      spinSpeed.current = 12 + Math.random() * 6;
      return;
    }

    if (!group.current) return;

    const target = quaternionForFace(value ?? 1);
    if (wasRolling.current) {
      settleFrom.current.copy(group.current.quaternion);
      settleTo.current.copy(target);
      settleT.current = 0;
      settling.current = true;
      wasRolling.current = false;
    } else {
      group.current.quaternion.copy(target);
      settling.current = false;
      settleT.current = 1;
    }
  }, [rolling, value]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;

    if (rolling) {
      g.rotateOnWorldAxis(spinAxis.current, spinSpeed.current * delta);
      return;
    }

    if (settling.current) {
      settleT.current = Math.min(1, settleT.current + delta / 0.28);
      const t = 1 - (1 - settleT.current) ** 3;
      g.quaternion.slerpQuaternions(
        settleFrom.current,
        settleTo.current,
        t,
      );
      if (settleT.current >= 1) settling.current = false;
    }
  });

  return (
    <group ref={group}>
      <RoundedBox args={[SIZE, SIZE, SIZE]} radius={0.12} smoothness={4}>
        <meshStandardMaterial color={body} roughness={0.35} metalness={0.05} />
      </RoundedBox>
      {([1, 2, 3, 4, 5, 6] as const).map((face) => (
        <FacePips key={face} face={face} color="#1a1510" />
      ))}
    </group>
  );
}

type Props = {
  value: number | null;
  color: Color;
  rolling?: boolean;
};

export function Dice3D({ value, color, rolling }: Props) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0.35, 2.4], fov: 35 }}
      style={{
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        touchAction: "none",
      }}
      frameloop="always"
    >
      <ambientLight intensity={0.85} />
      <directionalLight position={[2, 3, 4]} intensity={1.1} />
      <directionalLight position={[-2, -1, 2]} intensity={0.35} />
      <DieMesh value={value} color={color} rolling={rolling} />
    </Canvas>
  );
}
