import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  hsFetch,
  searchAllDeals,
  fetchOwnerMap,
  isClosedWon,
  dealAmount,
  pipelineLabel,
  dateEnteredProp,
  APPOINTMENT_STAGE_IDS,
  APPOINTMENT_DATE_PROPS,
  QUOTED_STAGE_IDS,
  enteredAnyStage,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  dateFrom?: string
  dateTo?: string
}

type DealDetail = {
  id: string
  name: string
  ownerId: string
  ownerName: string
  pipeline: string
  stage: string
  region: string
  subRegion: string
  territory: string
  amount: number
  won: boolean
  quoted: boolean
  apptSet: boolean
  createDate: string | null
  apptDate: string | null
  quotedDate: string | null
  wonDate: string | null
}

// HubSpot v3 returns datetime props either as ISO strings or epoch-ms strings.
function parseDate(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Earliest timestamp the deal entered any of the given stages (ms), else null.
function earliestStageMs(p: Record<string, string | null>, stageIds: Set<string>): number | null {
  let best: number | null = null
  for (const id of stageIds) {
    const t = parseDate(p[dateEnteredProp(id)])
    if (t !== null && (best === null || t < best)) best = t
  }
  return best
}

function isoOrNull(v: string | null | undefined): string | null {
  const t = parseDate(v)
  return t !== null ? new Date(t).toISOString() : null
}

function labelOrUnassigned(v: string | null | undefined): string {
  const s = (v || "").trim()
  return s || "Unassigned"
}

// Fetch stage id -> label across all deal pipelines.
async function fetchStageLabels(token: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  try {
    const data = await hsFetch<{ results: { stages: { id: string; label: string }[] }[] }>(
      "/crm/v3/pipelines/deals",
      { token, method: "GET" },
    )
    for (const pl of data.results || []) {
      for (const s of pl.stages || []) map[s.id] = s.label
    }
  } catch {
    // best-effort; falls back to the raw stage id
  }
  return map
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const now = new Date()
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(now.getFullYear(), 0, 1)
  const to = body.dateTo ? new Date(body.dateTo) : now
  const fromMs = from.getTime()
  const toMs = to.getTime()

  try {
    // This report is APPOINTMENT-CENTRIC: filter deals by the date they entered
    // an appointment stage (hs_v2_date_entered_<apptStageId>) within the range,
    // NOT by create/close date. One filterGroup per appointment stage id (OR'd
    // by HubSpot), which returns any deal that entered an appt stage in-window.
    const apptGroups = APPOINTMENT_DATE_PROPS.map((prop) => ({
      filters: [
        { propertyName: prop, operator: "GTE", value: String(fromMs) },
        { propertyName: prop, operator: "LTE", value: String(toMs) },
      ],
    }))

    const rawDeals = await searchAllDeals(token, apptGroups)
    const [ownerMap, stageLabels] = await Promise.all([fetchOwnerMap(token), fetchStageLabels(token)])

    const ownerSet = new Map<string, string>()
    const deals: DealDetail[] = []

    for (const d of rawDeals as HubSpotDeal[]) {
      const p = d.properties
      // Keep only deals whose earliest appointment date lands inside the window,
      // so the report matches the "appointment scheduled" column exactly.
      const apptMs = earliestStageMs(p, APPOINTMENT_STAGE_IDS)
      if (apptMs === null || apptMs < fromMs || apptMs > toMs) continue

      const ownerId = p.hubspot_owner_id || ""
      const ownerName = ownerId ? ownerMap[ownerId] || `Owner ${ownerId}` : "Unassigned"
      ownerSet.set(ownerId, ownerName)

      const won = isClosedWon(d)
      const quoted = won || enteredAnyStage(d, QUOTED_STAGE_IDS)
      const stageId = p.dealstage || ""

      deals.push({
        id: d.id,
        name: p.dealname || "(no name)",
        ownerId,
        ownerName,
        pipeline: pipelineLabel(p.pipeline),
        stage: stageLabels[stageId] || stageId || "—",
        region: labelOrUnassigned(p.er_region),
        subRegion: labelOrUnassigned(p.er_sub_region),
        territory: labelOrUnassigned(p.er_territory),
        amount: dealAmount(d),
        won,
        quoted,
        apptSet: true,
        createDate: isoOrNull(p.createdate),
        apptDate: new Date(apptMs).toISOString(),
        quotedDate: isoOrNull(earliestQuotedIso(p)),
        wonDate: won ? isoOrNull(p.closedate) : null,
      })
    }

    const owners = Array.from(ownerSet, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({
      configured: true,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      owners,
      deals,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

// Earliest quoted-stage entry as an epoch-ms string (or null), for isoOrNull.
function earliestQuotedIso(p: Record<string, string | null>): string | null {
  const t = earliestStageMs(p, QUOTED_STAGE_IDS)
  return t !== null ? String(t) : null
}
