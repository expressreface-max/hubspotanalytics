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

type DealMeeting = {
  id: string
  name: string
  ownerName: string
  pipeline: string
  stage: string
  region: string
  subRegion: string
  territory: string
  amount: number
  won: boolean
  quoted: boolean
  createDate: string | null
  apptDate: string | null // date the deal entered the appointment stage
  meetingDate: string | null // actual meeting engagement start time (earliest)
  meetingTitle: string | null
  meetingOutcome: string | null
  meetingCount: number
}

function parseDate(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

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

// deal id -> [meeting ids] via the v4 associations batch-read API.
async function fetchDealMeetingIds(token: string, dealIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  for (const ids of chunk(dealIds, 100)) {
    const data = await hsFetch<{
      results: { from: { id: string }; to: { toObjectId: number }[] }[]
    }>("/crm/v4/associations/deals/meetings/batch/read", {
      token,
      method: "POST",
      body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
    })
    for (const r of data.results || []) {
      map.set(
        r.from.id,
        (r.to || []).map((t) => String(t.toObjectId)),
      )
    }
  }
  return map
}

// meeting id -> { start, title, outcome } via the meetings batch-read API.
async function fetchMeetings(
  token: string,
  meetingIds: string[],
): Promise<Map<string, { start: number | null; title: string | null; outcome: string | null }>> {
  const map = new Map<string, { start: number | null; title: string | null; outcome: string | null }>()
  for (const ids of chunk(meetingIds, 100)) {
    const data = await hsFetch<{
      results: { id: string; properties: Record<string, string | null> }[]
    }>("/crm/v3/objects/meetings/batch/read", {
      token,
      method: "POST",
      body: JSON.stringify({
        properties: ["hs_meeting_start_time", "hs_timestamp", "hs_meeting_title", "hs_meeting_outcome"],
        inputs: ids.map((id) => ({ id })),
      }),
    })
    for (const m of data.results || []) {
      const p = m.properties
      map.set(m.id, {
        start: parseDate(p.hs_meeting_start_time) ?? parseDate(p.hs_timestamp),
        title: p.hs_meeting_title || null,
        outcome: p.hs_meeting_outcome || null,
      })
    }
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
    // Appointment-centric: filter deals by the date they entered an appointment
    // stage within the range (one OR'd filterGroup per appt stage-entered prop).
    const apptGroups = APPOINTMENT_DATE_PROPS.map((prop) => ({
      filters: [
        { propertyName: prop, operator: "GTE", value: String(fromMs) },
        { propertyName: prop, operator: "LTE", value: String(toMs) },
      ],
    }))

    const rawDeals = await searchAllDeals(token, apptGroups)
    const [ownerMap, stageLabels] = await Promise.all([fetchOwnerMap(token), fetchStageLabels(token)])

    // Keep only deals whose earliest appointment date is inside the window.
    const kept: { deal: HubSpotDeal; apptMs: number }[] = []
    for (const d of rawDeals as HubSpotDeal[]) {
      const apptMs = earliestStageMs(d.properties, APPOINTMENT_STAGE_IDS)
      if (apptMs === null || apptMs < fromMs || apptMs > toMs) continue
      kept.push({ deal: d, apptMs })
    }

    // Enrich with associated meetings (deal -> meetings -> start time).
    const dealMeetingIds = await fetchDealMeetingIds(
      token,
      kept.map((k) => k.deal.id),
    )
    const allMeetingIds = [...new Set([...dealMeetingIds.values()].flat())]
    const meetings = allMeetingIds.length ? await fetchMeetings(token, allMeetingIds) : new Map()

    const deals: DealMeeting[] = kept.map(({ deal, apptMs }) => {
      const p = deal.properties
      const ownerId = p.hubspot_owner_id || ""
      const ownerName = ownerId ? ownerMap[ownerId] || `Owner ${ownerId}` : "Unassigned"
      const won = isClosedWon(deal)
      const quoted = won || enteredAnyStage(deal, QUOTED_STAGE_IDS)
      const stageId = p.dealstage || ""

      // Choose the earliest-starting meeting as the deal's meeting date.
      const mids = dealMeetingIds.get(deal.id) || []
      let best: { start: number | null; title: string | null; outcome: string | null } | null = null
      for (const mid of mids) {
        const m = meetings.get(mid)
        if (!m) continue
        if (m.start === null) continue
        if (best === null || best.start === null || (m.start ?? Infinity) < (best.start ?? Infinity)) best = m
      }

      return {
        id: deal.id,
        name: p.dealname || "(no name)",
        ownerName,
        pipeline: pipelineLabel(p.pipeline),
        stage: stageLabels[stageId] || stageId || "—",
        region: labelOrUnassigned(p.er_region),
        subRegion: labelOrUnassigned(p.er_sub_region),
        territory: labelOrUnassigned(p.er_territory),
        amount: dealAmount(deal),
        won,
        quoted,
        createDate: isoOrNull(p.createdate),
        apptDate: new Date(apptMs).toISOString(),
        meetingDate: best?.start != null ? new Date(best.start).toISOString() : null,
        meetingTitle: best?.title ?? null,
        meetingOutcome: best?.outcome ?? null,
        meetingCount: mids.length,
      }
    })

    return NextResponse.json({
      configured: true,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      deals,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
