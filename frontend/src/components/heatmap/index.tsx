"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "../ui";

// Leaflet touches `window`, so the map renders on the client only.
const HeatmapMap = dynamic(() => import("./HeatmapMap"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export default HeatmapMap;
