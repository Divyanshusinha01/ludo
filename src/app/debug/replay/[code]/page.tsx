import { notFound } from "next/navigation";
import { ReplayClient } from "./ReplayClient";

export default async function ReplayDebugPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_ENABLE_REPLAY_DEBUG === "1";
  if (!enabled) notFound();

  const { code } = await params;
  return (
    <main style={{ minHeight: "100dvh", padding: "1rem" }}>
      <ReplayClient code={code} />
    </main>
  );
}
