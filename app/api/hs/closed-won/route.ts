import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  fetchOwnerMap,
  isClosedWon,
  dealAmount,
  pipelineLabel,
  HubSpotError,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  dateFrom?: string
  dateTo?: string
  pipelines?: string[]
}

type WonDeal = {
  id: string
  name: string
  closeDate: string | null
  amount: number
  ownerName: string
  pipeline: string
}

function inRange(iso: string | null | undefined, from: number, to: number): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= from && t <= to
}

// Build the OR'd filter groups for a closed-won search by close date in range,
// optionally scoped to specific pipelines.
function buildGroups(from: string, to: string, pipelines?: string[]) {
  const base = [
    { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
    { propertyName: "closedate", operator: "GTE", value: from },
    { propertyName: "closedate", operator: "LTE", value: to },
  ]
  if (pipelines && pipelines.length > 0) {
    return pipelines.map((p) => ({
      filters: [...base, { propertyName: "pipeline", operator: "EQ", value: p }],
    }))
  }
  return [{ filters: base }]
}

export async function POST(req: Request) {
  const token = await getActiveToken()
  if (!token) {
    return NextResponse.json({ configured: false, error: "HubSpot not connected." }, { status: 200 })
  }

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    // empty body allowed
  }

  const to = body.dateTo ? new Date(body.dateTo) : new Date()
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000)
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(toMs).toISOString()

  try {
    const [deals, ownerMap] = await Promise.all([
      searchAllDeals(token, buildGroups(fromIso, toIso, body.pipelines)),
      fetchOwnerMap(token),
    ])

    const rows: WonDeal[] = []
    for (const d of deals) {
      const p = d.properties
      // Defensive: the search should already scope this, but re-check both the
      // won flag and that the close date is genuinely inside the window.
      if (!isClosedWon(d)) continue
      if (!inRange(p.closedate, fromMs, toMs)) continue

      const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null
      rows.push({
        id: d.id,
        name: p.dealname || "(unnamed deal)",
        closeDate: p.closedate || null,
        amount: dealAmount(d),
        ownerName: (ownerId && ownerMap[ownerId]) || "Unassigned",
        pipeline: pipelineLabel(p.pipeline),
      })
    }

    // Newest close date first.
    rows.sort((a, b) => {
      const at = a.closeDate ? Date.parse(a.closeDate) : 0
      const bt = b.closeDate ? Date.parse(b.closeDate) : 0
      return bt - at
    })

    const totalAmount = rows.reduce((s, r) => s + r.amount, 0)

    return NextResponse.json({
      configured: true,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      deals: rows,
      totalAmount,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ configured: true, error: err.message }, { status: 200 })
    }
    return NextResponse.json(
      { configured: true, error: (err as Error)?.message || "Failed to load closed-won deals." },
      { status: 200 },
    )
  }
}
