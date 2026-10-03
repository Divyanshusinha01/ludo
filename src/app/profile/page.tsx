import type { Metadata } from "next";
import { ProfileShell } from "./ProfileShell";

export const metadata: Metadata = {
  title: "Your profile · Family Ludo",
};

export default function ProfilePage() {
  return (
    <main
      style={{
        padding:
          "max(1.25rem, env(safe-area-inset-top)) max(1.25rem, env(safe-area-inset-right)) max(1.25rem, env(safe-area-inset-bottom)) max(1.25rem, env(safe-area-inset-left))",
        minHeight: "100dvh",
      }}
    >
      <ProfileShell />
    </main>
  );
}
