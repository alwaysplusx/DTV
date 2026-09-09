import React, { Suspense } from "react";
import { LoadingDots } from "@/components/common/LoadingDots";
import PlayerWindowContent from "./PlayerWindowContent";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1, minHeight: 0 }}>
          <LoadingDots />
        </div>
      }
    >
      <PlayerWindowContent />
    </Suspense>
  );
}
