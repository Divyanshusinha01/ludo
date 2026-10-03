"use client";

import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { OPS_FLUSH_MS, OpsReporter } from "@/lib/opsReporter";

/** One batched metrics reporter per mounted room screen. */
export function useOpsReporter(
  roomId: Id<"rooms">,
  clientId: string,
): OpsReporter {
  const report = useMutation(api.ops.reportClientEvents);
  const [reporter] = useState(() => new OpsReporter());

  useEffect(() => {
    reporter.setSend((events) => report({ roomId, clientId, events }));
  }, [reporter, report, roomId, clientId]);

  useEffect(() => {
    const flush = () => {
      void reporter.flush();
    };
    const id = setInterval(flush, OPS_FLUSH_MS);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [reporter]);

  return reporter;
}
