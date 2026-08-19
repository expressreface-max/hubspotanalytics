import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  fetchOwnerMap,
  dealAmount,
  pipelineLabel,
  dateEnteredProp,
  SCHEDULED_STAGE_IDS,
  HubSpotError,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  dateFrom?: string
  dateTo?: string
  pipelines?: string[]
}

type ScheduledDeal = {
  id: string
  name: string
  scheduledDate: string | null
  amount: number
  ownerName: string
  pipeline: string
}

// The earliest stage-entered date (across the Scheduled stage props) that falls
// within [from, to]. This is the date the deal was scheduled during the window.
function scheduledDateInRange(
  props: Record<string, string | null | undefined>,
  from: number,
  to: number,
): string | null {
  let best: { iso: string; t: number } | null = null
  for (const id of SCHEDULED_STAGE_IDS) {
    const iso = props[dateEnteredProp(id)]
    if (!iso) continue
    const t = Date.parse(iso)
    if (Number.isNaN(t) || t < from || t > to) continue
    if (!best || t < best.t) best = { iso, t }
  }
  return best?.iso ?? null
}

// Build OR'd filter groups: a deal matches if it entered ANY Scheduled stage
// within the date range. One filterGroup per stage id (groups are OR'd), each
// optionally scoped to a pipeline.
function buildGroups(from: string, to: string, pipelines?: string[]) {
  const groups: { filters: { propertyName: string; operator: string; value: string }[] }[] = []
  for (const id of SCHEDULED_STAGE_IDS) {
    const prop = dateEnteredProp(id)
    const base = [
      { propertyName: prop, operator: "GTE", value: from },
      { propertyName: prop, operator: "LTE", value: to },
    ]
    if (pipelines && pipelines.length > 0) {
      for (const p of pipelines) {
        groups.push({ filters: [...base, { propertyName: "pipeline", operator: "EQ", value: p }] })
      }
    } else {
      groups.push({ filters: base })
    }
  }
  return groups
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

    const rows: ScheduledDeal[] = []
    for (const d of deals) {
      const p = d.properties
      // Only keep deals whose Scheduled stage-entered date is genuinely in range.
      const scheduledDate = scheduledDateInRange(p, fromMs, toMs)
      if (!scheduledDate) continue

      const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null
      rows.push({
        id: d.id,
        name: p.dealname || "(unnamed deal)",
        scheduledDate,
        amount: dealAmount(d),
        ownerName: (ownerId && ownerMap[ownerId]) || "Unassigned",
        pipeline: pipelineLabel(p.pipeline),
      })
    }

    // Newest scheduled date first.
    rows.sort((a, b) => {
      const at = a.scheduledDate ? Date.parse(a.scheduledDate) : 0
      const bt = b.scheduledDate ? Date.parse(b.scheduledDate) : 0
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
      { configured: true, error: (err as Error)?.message || "Failed to load scheduled deals." },
      { status: 200 },
    )
  }
}
