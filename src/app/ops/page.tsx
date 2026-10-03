import { notFound } from "next/navigation";
import { OpsShell } from "./OpsShell";

export default function OpsDashboardPage() {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.NEXT_PUBLIC_ENABLE_OPS_DASHBOARD === "1";
  if (!enabled) notFound();

  return (
    <main style={{ minHeight: "100dvh", padding: "1rem" }}>
      <OpsShell />
    </main>
  );
}
