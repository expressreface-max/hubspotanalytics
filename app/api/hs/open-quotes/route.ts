import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  hsFetch,
  searchAllDeals,
  dealAmount,
  pipelineLabel,
  fetchOwnerMap,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const DAY = 24 * 60 * 60 * 1000

export type OpenQuoteRow = {
  dealId: string
  dealName: string
  pipeline: string
  stage: string
  amount: number
  quotedDate: string | null
  ageDays: number | null
  lastContacted: string | null
  daysSinceContact: number | null
}
export type OpenQuoteRepGroup = { rep: string; count: number; amount: number; deals: OpenQuoteRow[] }
export type OpenQuotesData = {
  configured: boolean
  asOf: string
  totalCount: number
  totalAmount: number
  byRep: OpenQuoteRepGroup[]
  error?: string
}

function parseTime(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Earliest date the deal entered any Quoted stage (its "quoted on" date).
function quotedTime(deal: HubSpotDeal): number | null {
  let min: number | null = null
  for (const prop of QUOTED_DATE_PROPS) {
    const t = parseTime(deal.properties[prop])
    if (t != null && (min == null || t < min)) min = t
  }
  return min
}

// Stage id -> label across all deal pipelines (best-effort).
async function fetchStageLabels(token: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  try {
    const data = await hsFetch<{ results: { stages: { id: string; label: string }[] }[] }>(
      "/crm/v3/pipelines/deals",
      { token, method: "GET" },
    )
    for (const pl of data.results || []) for (const s of pl.stages || []) map[s.id] = s.label
  } catch {
    /* fall back to raw id */
  }
  return map
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "Not configured", configured: false } as OpenQuotesData, { status: 200 })

  try {
    const now = Date.now()
    // Deals CURRENTLY in a Quoted stage, Express Reface pipeline only.
    const quotedStageIds = [...QUOTED_STAGE_IDS]
    const filterGroups = [
      {
        filters: [
          { propertyName: "dealstage", operator: "IN", values: quotedStageIds },
          { propertyName: "pipeline", operator: "EQ", value: "default" },
        ],
      },
    ]
    const props = [...DEAL_PROPERTIES, "notes_last_contacted", "dealstage"]

    const [dealsRaw, ownerMap, stageLabels] = await Promise.all([
      searchAllDeals(token, filterGroups, props, 60),
      fetchOwnerMap(token),
      fetchStageLabels(token),
    ])

    // Exclude internal / training deals.
    const deals = dealsRaw.filter((d) => {
      const name = (d.properties.dealname || "").toLowerCase()
      return !name.includes("doug schubert") && !name.includes("training")
    })

    const groups = new Map<string, OpenQuoteRow[]>()
    let totalAmount = 0
    for (const d of deals) {
      const p = d.properties
      const qt = quotedTime(d)
      const ageDays = qt == null ? null : Math.max(0, Math.round((now - qt) / DAY))
      const contactMs = parseTime(p.notes_last_contacted)
      const daysSinceContact = contactMs == null ? null : Math.max(0, Math.round((now - contactMs) / DAY))
      const amount = dealAmount(d)
      totalAmount += amount
      const rep = p.hubspot_owner_id ? ownerMap[p.hubspot_owner_id] || `Owner ${p.hubspot_owner_id}` : "Unassigned"
      const row: OpenQuoteRow = {
        dealId: d.id,
        dealName: p.dealname || `Deal ${d.id}`,
        pipeline: pipelineLabel(p.pipeline),
        stage: stageLabels[p.dealstage || ""] || p.dealstage || "—",
        amount,
        quotedDate: qt != null ? new Date(qt).toISOString() : null,
        ageDays,
        lastContacted: contactMs != null ? new Date(contactMs).toISOString() : null,
        daysSinceContact,
      }
      const list = groups.get(rep) || []
      list.push(row)
      groups.set(rep, list)
    }

    // Oldest quotes first within each rep (most in need of follow-up); reps by count desc.
    const byRep: OpenQuoteRepGroup[] = [...groups.entries()]
      .map(([rep, list]) => {
        list.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
        return { rep, count: list.length, amount: list.reduce((s, r) => s + r.amount, 0), deals: list }
      })
      .sort((a, b) => b.count - a.count || b.amount - a.amount)

    const payload: OpenQuotesData = {
      configured: true,
      asOf: new Date(now).toISOString(),
      totalCount: deals.length,
      totalAmount,
      byRep,
    }
    return NextResponse.json(payload)
  } catch (err: any) {
    const status = err?.status && Number.isFinite(err.status) ? err.status : 500
    return NextResponse.json(
      { configured: true, asOf: new Date().toISOString(), totalCount: 0, totalAmount: 0, byRep: [], error: err?.message || "Failed to load open quotes" } as OpenQuotesData,
      { status },
    )
  }
}
