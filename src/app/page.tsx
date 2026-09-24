import { HomeScreen } from "@/components/HomeScreen";

export default function Home() {
  return (
    <main
      style={{
        padding:
          "max(1.25rem, env(safe-area-inset-top)) max(1.25rem, env(safe-area-inset-right)) max(1.25rem, env(safe-area-inset-bottom)) max(1.25rem, env(safe-area-inset-left))",
        minHeight: "100dvh",
      }}
    >
      <HomeScreen />
    </main>
  );
}
