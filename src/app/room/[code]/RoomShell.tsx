"use client";

import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { RoomClient } from "./RoomClient";

export function RoomShell({
  code,
  roomIdHint,
}: {
  code: string;
  roomIdHint?: string;
}) {
  return (
    <ConvexClientProvider>
      <RoomClient code={code} roomIdHint={roomIdHint} />
    </ConvexClientProvider>
  );
}
