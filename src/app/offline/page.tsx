import { OfflineClient } from "./OfflineClient";

export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        padding: "1rem 1rem 1.25rem",
        boxSizing: "border-box",
      }}
    >
      <OfflineClient />
    </main>
  );
}
