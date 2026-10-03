import { HomeScreen } from "@/components/HomeScreen";
import { ProfileMenu } from "@/components/ProfileMenu";

export default function Home() {
  return (
    <main
      style={{
        padding:
          "max(1.25rem, env(safe-area-inset-top)) max(1.25rem, env(safe-area-inset-right)) max(1.25rem, env(safe-area-inset-bottom)) max(1.25rem, env(safe-area-inset-left))",
        minHeight: "100dvh",
      }}
    >
      <header style={{ display: "flex", justifyContent: "flex-end", minHeight: "2.6rem" }}>
        <ProfileMenu />
      </header>
      <HomeScreen />
    </main>
  );
}
