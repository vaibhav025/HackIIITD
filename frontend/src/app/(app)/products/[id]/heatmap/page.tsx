import { redirect } from "next/navigation";

/** Legacy route: the heatmap lives at /heatmap with the product preselected. */
export default async function ProductHeatmapRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/heatmap?product=${encodeURIComponent(id)}`);
}
