"use client";

import { Suspense } from "react";

import { StatsScreen } from "@/components/stats/StatsScreen";

export default function StatsPage() {
  return (
    <Suspense fallback={null}>
      <StatsScreen />
    </Suspense>
  );
}
