import { RoomShell } from "./RoomShell";

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ rid?: string | string[] }>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const ridRaw = sp.rid;
  const roomIdHint = typeof ridRaw === "string" ? ridRaw : undefined;

  return (
    <main
      style={{
        padding:
          "max(0.5rem, env(safe-area-inset-top)) max(0.5rem, env(safe-area-inset-right)) max(0.35rem, env(safe-area-inset-bottom)) max(0.5rem, env(safe-area-inset-left))",
        minHeight: "100dvh",
      }}
    >
      <RoomShell code={code} roomIdHint={roomIdHint} />
    </main>
  );
}
