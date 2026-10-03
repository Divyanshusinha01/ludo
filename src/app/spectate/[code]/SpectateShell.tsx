"use client";

import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { SpectateClient } from "./SpectateClient";

export function SpectateShell({ code }: { code: string }) {
  return (
    <ConvexClientProvider>
      <SpectateClient code={code} />
    </ConvexClientProvider>
  );
}
