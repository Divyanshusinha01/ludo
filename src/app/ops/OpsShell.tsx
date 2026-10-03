"use client";

import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { OpsClient } from "./OpsClient";

export function OpsShell() {
  return (
    <ConvexClientProvider>
      <OpsClient />
    </ConvexClientProvider>
  );
}
