import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  hsFetch,
  fetchOwnerMap,
  isClosedWon,
  isClosedLost,
  dealAmount,
  pipelineLabel,
  enteredAnyStage,
  QUOTED_STAGE_IDS,
  SCHEDULED_STAGE_IDS,
  DEAL_PROPERTIES,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = { dateFrom?: string; dateTo?: string }

type MeetingRecord = {
  id: string
  properties: {
    hs_meeting_start_time?: string | null
    hs_timestamp?: string | null
    hubspot_owner_id?: string | null
    hs_activity_type?: string | null
    hs_attendee_owner_ids?: string | null
  }
}

type ConsultRow = {
  dealId: string
  dealName: string
  pipeline: string
  stage: string
  territory: string
  amount: number
  meetingDate: string // ISO of the most recent consultation for this deal
  daysElapsed: number
}

type RepGroup = {
  rep: string
  count: number
  amount: number
  deals: ConsultRow[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function toMs(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function parseAttendeeOwnerIds(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Paginate meetings whose actual start time is within [fromMs, toMs].
async function searchMeetingsInRange(token: string, fromMs: number, toMs: number): Promise<MeetingRecord[]> {
  const results: MeetingRecord[] = []
  let after: string | undefined
  let pages = 0
  const maxPages = 60
  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_meeting_start_time",
              operator: "BETWEEN",
              value: String(fromMs),
              highValue: String(toMs),
            },
          ],
        },
      ],
      properties: [
        "hs_meeting_start_time",
        "hs_timestamp",
        "hubspot_owner_id",
        "hs_activity_type",
        "hs_attendee_owner_ids",
      ],
      limit: 100,
      sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
    }
    if (after) body.after = after

    const data = await hsFetch<{ results: MeetingRecord[]; paging?: { next?: { after: string } } }>(
      "/crm/v3/objects/meetings/search",
      { token, method: "POST", body: JSON.stringify(body) },
    )
    results.push(...(data.results || []))
    after = data.paging?.next?.after
    pages++
    if (after) await new Promise((r) => setTimeout(r, 300))
  } while (after && pages < maxPages)

  return results
}

// meeting id -> [deal ids] via the v4 associations batch-read API.
async function fetchMeetingDealIds(token: string, meetingIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  for (const ids of chunk(meetingIds, 100)) {
    const data = await hsFetch<{ results: { from: { id: string }; to: { toObjectId: number }[] }[] }>(
      "/crm/v4/associations/meetings/deals/batch/read",
      { token, method: "POST", body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }) },
    )
    for (const r of data.results || []) {
      map.set(
        r.from.id,
        (r.to || []).map((t) => String(t.toObjectId)),
      )
    }
  }
  return map
}

// Fetch stage id -> label across all deal pipelines (best-effort).
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
    // falls back to the raw stage id
  }
  return map
}

// deal id -> deal (with stage-history + territory props) via batch-read.
async function fetchDeals(token: string, dealIds: string[]): Promise<Map<string, HubSpotDeal>> {
  const map = new Map<string, HubSpotDeal>()
  for (const ids of chunk(dealIds, 100)) {
    const data = await hsFetch<{ results: HubSpotDeal[] }>("/crm/v3/objects/deals/batch/read", {
      token,
      method: "POST",
      body: JSON.stringify({ properties: [...DEAL_PROPERTIES, "hs_is_closed"], inputs: ids.map((id) => ({ id })) }),
    })
    for (const d of data.results || []) map.set(d.id, d)
  }
  return map
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) {
    return NextResponse.json({ configured: false, error: "HubSpot not connected." }, { status: 200 })
  }

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    // empty body allowed
  }

  const now = Date.now()
  // Upper bound: meeting happened 1+ full days ago. Lower bound: 90 days back.
  const toMsHigh = body.dateTo ? new Date(body.dateTo).getTime() : now - DAY_MS
  const fromMs = body.dateFrom ? new Date(body.dateFrom).getTime() : now - 90 * DAY_MS

  try {
    const meetings = await searchMeetingsInRange(token, fromMs, toMsHigh)

    // Consultations only (blank/other types dropped), and genuinely in range.
    const consults = meetings.filter((m) => {
      const t = toMs(m.properties.hs_meeting_start_time)
      if (t === null || t < fromMs || t > toMsHigh) return false
      return (m.properties.hs_activity_type || "").trim().toLowerCase() === "consultation"
    })

    if (consults.length === 0) {
      return NextResponse.json({
        configured: true,
        dateFrom: new Date(fromMs).toISOString(),
        dateTo: new Date(toMsHigh).toISOString(),
        generatedAt: new Date(now).toISOString(),
        totalConsults: 0,
        totalAmount: 0,
        byRep: [],
      })
    }

    // Associate each consultation meeting to its deal(s).
    const meetingDealIds = await fetchMeetingDealIds(
      token,
      consults.map((m) => m.id),
    )
    const allDealIds = [...new Set([...meetingDealIds.values()].flat())]
    const [deals, ownerMap, stageLabels] = await Promise.all([
      allDealIds.length ? fetchDeals(token, allDealIds) : Promise.resolve(new Map<string, HubSpotDeal>()),
      fetchOwnerMap(token),
      fetchStageLabels(token),
    ])

    // Build one candidate row per (consultation meeting, associated open-quote deal).
    // A deal counts only if it has NOT entered a Quoted / Scheduled stage and is
    // not closed won (i.e. it never reached quote-or-beyond in the pipeline).
    // Rep = the meeting ATTENDEE (first attendee != scheduler, else first, else scheduler).
    type Raw = { rep: string; deal: HubSpotDeal; meetingMs: number }
    const raws: Raw[] = []

    for (const m of consults) {
      const meetingMs = toMs(m.properties.hs_meeting_start_time)
      if (meetingMs === null) continue
      const dealIds = meetingDealIds.get(m.id) || []
      // Find the first associated deal that is still un-quoted.
      const openDeal = dealIds
        .map((id) => deals.get(id))
        .find(
          (d): d is HubSpotDeal =>
            !!d &&
            !enteredAnyStage(d, QUOTED_STAGE_IDS) &&
            !enteredAnyStage(d, SCHEDULED_STAGE_IDS) &&
            !isClosedWon(d) &&
            !isClosedLost(d),
        )
      if (!openDeal) continue

      const scheduler = m.properties.hubspot_owner_id ? String(m.properties.hubspot_owner_id) : null
      const attendees = parseAttendeeOwnerIds(m.properties.hs_attendee_owner_ids)
      const ownerId = attendees.find((id) => id !== scheduler) || attendees[0] || scheduler
      const rep = (ownerId && ownerMap[String(ownerId)]) || "Unassigned"

      raws.push({ rep, deal: openDeal, meetingMs })
    }

    // Dedupe to one row per deal, keeping its MOST RECENT consultation (largest
    // meetingMs = smallest days elapsed), so a deal with multiple consults isn't
    // listed twice.
    const byDeal = new Map<string, Raw>()
    for (const r of raws) {
      const prev = byDeal.get(r.deal.id)
      if (!prev || r.meetingMs > prev.meetingMs) byDeal.set(r.deal.id, r)
    }

    const repMap = new Map<string, RepGroup>()
    let totalAmount = 0

    for (const { rep, deal, meetingMs } of byDeal.values()) {
      const p = deal.properties
      const amount = dealAmount(deal)
      const daysElapsed = Math.floor((now - meetingMs) / DAY_MS)
      const row: ConsultRow = {
        dealId: deal.id,
        dealName: p.dealname || `Deal ${deal.id}`,
        pipeline: pipelineLabel(p.pipeline),
        stage: stageLabels[p.dealstage || ""] || p.dealstage || "—",
        territory: (p.er_territory || "").trim() || "Unmapped",
        amount,
        meetingDate: new Date(meetingMs).toISOString(),
        daysElapsed,
      }
      let g = repMap.get(rep)
      if (!g) {
        g = { rep, count: 0, amount: 0, deals: [] }
        repMap.set(rep, g)
      }
      g.deals.push(row)
      g.count += 1
      g.amount += amount
      totalAmount += amount
    }

    // Sort each rep's deals by days elapsed ascending (smallest -> largest), and
    // order reps by outstanding-consult count (then name).
    const byRep = [...repMap.values()]
      .map((g) => ({ ...g, deals: g.deals.sort((a, b) => a.daysElapsed - b.daysElapsed) }))
      .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep))

    return NextResponse.json({
      configured: true,
      dateFrom: new Date(fromMs).toISOString(),
      dateTo: new Date(toMsHigh).toISOString(),
      generatedAt: new Date(now).toISOString(),
      totalConsults: byDeal.size,
      totalAmount,
      byRep,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ configured: true, error: err.message }, { status: 200 })
    }
    return NextResponse.json(
      { configured: true, error: (err as Error)?.message || "Failed to load consultations." },
      { status: 200 },
    )
  }
}
