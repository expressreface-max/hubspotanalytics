import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, HubSpotError, pipelineLabel } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  try {
    const data = await hsFetch<{ results: any[] }>("/crm/v3/pipelines/deals", {
      token,
      method: "GET",
    })
    const pipelines = (data.results || []).map((p) => ({
      id: p.pipelineId ?? p.id,
      label: p.label ?? pipelineLabel(p.pipelineId ?? p.id),
      stages: (p.stages || []).map((s: any) => ({
        id: s.stageId ?? s.id,
        label: s.label,
        displayOrder: s.displayOrder,
        isClosedWon: s.metadata?.isClosed === "true" && s.metadata?.probability === "1.0",
      })),
    }))
    return NextResponse.json({ pipelines })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
