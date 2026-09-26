import { OfflineClient } from "./OfflineClient";

export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        padding: "1.25rem 1rem 2rem",
        boxSizing: "border-box",
      }}
    >
      <OfflineClient />
    </main>
  );
}
