import { RoomClient } from "./RoomClient";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <main style={{ padding: "1rem", minHeight: "100dvh" }}>
      <RoomClient code={code} />
    </main>
  );
}
