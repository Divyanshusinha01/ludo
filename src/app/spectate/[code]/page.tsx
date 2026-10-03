import { SpectateShell } from "./SpectateShell";

export default async function SpectatePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return (
    <main
      style={{
        padding:
          "max(0.5rem, env(safe-area-inset-top)) max(0.5rem, env(safe-area-inset-right)) max(0.35rem, env(safe-area-inset-bottom)) max(0.5rem, env(safe-area-inset-left))",
        minHeight: "100dvh",
      }}
    >
      <SpectateShell code={code} />
    </main>
  );
}
