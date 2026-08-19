import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  isClosedWon,
  dealAmount,
  pipelineLabel,
  HubSpotError,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type Body = {
  dateField?: "createdate" | "closedate"
  dateFrom?: string
  dateTo?: string
  pipelines?: string[]
  groupBy?: "pipeline" | "er_region" | "er_sub_region" | "er_territory" | "dealstage" | "zip"
  metric?: "count" | "revenue" | "won"
  onlyWon?: boolean
}

const GROUP_LABELS: Record<string, string> = {
  pipeline: "Pipeline",
  er_region: "Region",
  er_sub_region: "Sub-region",
  er_territory: "Territory",
  dealstage: "Deal stage",
  zip: "ZIP code",
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const dateField = body.dateField || "createdate"
  const groupBy = body.groupBy || "pipeline"
  const metric = body.metric || "count"

  const filters: any[] = []
  if (body.dateFrom) filters.push({ propertyName: dateField, operator: "GTE", value: String(new Date(body.dateFrom).getTime()) })
  if (body.dateTo) filters.push({ propertyName: dateField, operator: "LTE", value: String(new Date(body.dateTo).getTime()) })
  if (body.onlyWon) filters.push({ propertyName: "hs_is_closed_won", operator: "EQ", value: "true" })

  const filterGroups =
    body.pipelines && body.pipelines.length
      ? body.pipelines.map((p) => ({ filters: [...filters, { propertyName: "pipeline", operator: "EQ", value: p }] }))
      : [{ filters }]

  try {
    const deals = await searchAllDeals(token, filterGroups)
    const buckets: Record<string, number> = {}

    for (const deal of deals) {
      let key = (deal.properties[groupBy] || "").trim()
      if (groupBy === "pipeline") key = pipelineLabel(deal.properties.pipeline)
      if (!key) key = "(none)"

      let val = 0
      if (metric === "count") val = 1
      else if (metric === "revenue") val = dealAmount(deal)
      else if (metric === "won") val = isClosedWon(deal) ? 1 : 0

      buckets[key] = (buckets[key] || 0) + val
    }

    const rows = Object.entries(buckets)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)

    return NextResponse.json({
      groupBy,
      groupLabel: GROUP_LABELS[groupBy] || groupBy,
      metric,
      totalDeals: deals.length,
      rows,
    })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
