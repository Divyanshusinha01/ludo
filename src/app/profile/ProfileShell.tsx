"use client";

import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { ProfileClient } from "./ProfileClient";

export function ProfileShell() {
  return (
    <ConvexClientProvider>
      <ProfileClient />
    </ConvexClientProvider>
  );
}
